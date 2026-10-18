// Connection lifecycle after connecting: health checks, disconnection with
// credential revocation, and housekeeping for the cron route.

import 'server-only'

import { redact } from '@/lib/logging/redact'

import { getConnector } from '../connectors/registry'
import type { ConnectorDefinition } from '../connectors/types'
import { IntegrationError, isIntegrationError } from '../domain/errors'
import type { HealthStatus } from '../domain/types'
import { deleteTokens, getAccessToken, loadTokens, markNeedsReauth } from './credentials'
import { createHttpClient } from './http'
import { createRateLimitGate } from './rate-limit'
import type { IntegrationRuntime } from './runtime'

interface ConnectionRecord {
  id: string
  organization_id: string
  provider: string
  status: string
  external_account_id: string | null
  provider_metadata: unknown
}

async function loadRecord(runtime: IntegrationRuntime, organizationId: string, integrationId: string): Promise<ConnectionRecord | null> {
  const { data, error } = await runtime.admin
    .from('integrations')
    .select('id, organization_id, provider, status, external_account_id, provider_metadata')
    .eq('id', integrationId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) throw new IntegrationError('unavailable', { message: 'The connection couldn’t be loaded.', mayHaveReachedProvider: false })
  return data
}

export interface HealthReport {
  status: HealthStatus
  message: string
}

/** Calls the provider with the stored credentials and records the result on the connection. */
export async function checkHealth(runtime: IntegrationRuntime, organizationId: string, integrationId: string): Promise<HealthReport> {
  const record = await loadRecord(runtime, organizationId, integrationId)
  const connector = record ? getConnector(record.provider) : undefined
  if (!record || !connector) throw new IntegrationError('not_connected', { message: 'That connection doesn’t exist in this workspace.' })
  if (record.status !== 'connected' && record.status !== 'error') {
    return { status: 'unhealthy', message: record.status === 'revoked' ? 'Disconnected.' : 'Reconnect this integration.' }
  }

  const connection = { id: record.id, organizationId }
  let report: HealthReport
  let grantedScopes: string[] | undefined
  try {
    const accessToken = await getAccessToken(runtime, connector, connection)
    const http = createHttpClient({
      fetch: runtime.fetch,
      timeoutMs: connector.requestTimeoutMs,
      defaultBuckets: [connector.defaultRateLimitBucket],
      rateLimit: createRateLimitGate(runtime.admin, connector, connection),
    })
    const result = await connector.healthCheck({
      http,
      accessToken,
      connection: { ...connection, externalAccountId: record.external_account_id ?? '', metadata: (record.provider_metadata ?? {}) as Record<string, unknown> },
      signal: AbortSignal.timeout(connector.requestTimeoutMs),
    })
    report = { status: result.status, message: result.message }
    grantedScopes = result.grantedScopes
  } catch (error) {
    const failure = isIntegrationError(error) ? error : new IntegrationError('provider_error')
    if (failure.code === 'reauth_required') {
      await markNeedsReauth(runtime, connection, failure.message)
      return { status: 'unhealthy', message: failure.message }
    }
    report = {
      status: failure.retryable ? 'degraded' : 'unhealthy',
      message: failure.message,
    }
  }

  const { error } = await runtime.admin
    .from('integrations')
    .update({
      health_status: report.status,
      health_message: report.message.slice(0, 500),
      last_health_check_at: runtime.now().toISOString(),
      last_error: report.status === 'healthy' ? null : report.message.slice(0, 2000),
      ...(grantedScopes ? { granted_scopes: grantedScopes } : {}),
      ...(report.status === 'healthy' && record.status === 'error' ? { status: 'connected' } : {}),
    })
    .eq('id', record.id)
    .eq('organization_id', organizationId)
  if (error) console.error('[integrations] recording health failed', redact({ code: error.code }))
  return report
}

export type RevocationOutcome = 'revoked' | 'failed' | 'no_credentials'

export interface DisconnectResult {
  revocation: RevocationOutcome
  revocationError?: string
  cancelledExecutions: number
}

/**
 * Disconnects a connection: revokes the grant at the provider (best effort —
 * the connection is disconnected locally even if the provider can't be
 * reached), deletes the stored credentials, cancels actions still waiting to
 * run, and keeps the connection record (status "revoked") for history.
 */
export async function disconnect(
  runtime: IntegrationRuntime,
  params: { organizationId: string; integrationId: string; userId: string },
): Promise<DisconnectResult> {
  const record = await loadRecord(runtime, params.organizationId, params.integrationId)
  const connector = record ? getConnector(record.provider) : undefined
  if (!record || !connector) throw new IntegrationError('not_connected', { message: 'That connection doesn’t exist in this workspace.' })
  if (record.status === 'revoked') return { revocation: 'no_credentials', cancelledExecutions: 0 }

  const connection = { id: record.id, organizationId: params.organizationId }
  const { revocation, revocationError } = await revokeAtProvider(runtime, connector, connection)

  await deleteTokens(runtime, connection)

  const now = runtime.now().toISOString()
  const { error } = await runtime.admin
    .from('integrations')
    .update({
      status: 'revoked',
      revoked_at: now,
      health_status: 'unknown',
      health_message: 'Disconnected.',
      last_error: revocation === 'failed' ? `Disconnected, but ${connector.displayName} couldn’t confirm revocation: ${revocationError}`.slice(0, 2000) : null,
    })
    .eq('id', record.id)
    .eq('organization_id', params.organizationId)
  if (error) {
    console.error('[integrations] marking the connection revoked failed', redact({ code: error.code }))
    throw new IntegrationError('unavailable', { message: 'The connection couldn’t be disconnected. Please try again.', mayHaveReachedProvider: false })
  }

  const cancelledExecutions = await cancelPendingExecutions(runtime, connection)

  await runtime.admin.from('audit_logs').insert({
    organization_id: params.organizationId,
    actor_type: 'user',
    actor_user_id: params.userId,
    action: 'integration.disconnected',
    target_table: 'integrations',
    target_id: record.id,
    metadata: { provider: connector.provider, revocation, cancelled_executions: cancelledExecutions },
  })

  return { revocation, ...(revocationError ? { revocationError } : {}), cancelledExecutions }
}

async function revokeAtProvider(
  runtime: IntegrationRuntime,
  connector: ConnectorDefinition,
  connection: { id: string; organizationId: string },
): Promise<{ revocation: RevocationOutcome; revocationError?: string }> {
  let tokens
  try {
    tokens = await loadTokens(runtime, connection)
  } catch {
    return { revocation: 'failed', revocationError: 'the stored credentials couldn’t be read' }
  }
  if (!tokens) return { revocation: 'no_credentials' }
  try {
    const http = createHttpClient({ fetch: runtime.fetch, timeoutMs: connector.requestTimeoutMs, defaultBuckets: [] })
    await connector.auth.revoke(http, runtime.oauthClient(connector), tokens)
    return { revocation: 'revoked' }
  } catch (error) {
    // Already-invalid credentials count as revoked: the provider no longer honours them.
    if (isIntegrationError(error) && error.code === 'reauth_required') return { revocation: 'revoked' }
    const message = isIntegrationError(error) ? error.message : 'unexpected error'
    console.error('[integrations] provider revocation failed', redact({ provider: connector.provider, error }))
    return { revocation: 'failed', revocationError: message }
  }
}

/** Cancels actions of a connection that are waiting for approval or queued to run. */
async function cancelPendingExecutions(runtime: IntegrationRuntime, connection: { id: string; organizationId: string }): Promise<number> {
  const { data, error } = await runtime.admin
    .from('tool_executions')
    .update({ status: 'cancelled', error: { code: 'not_connected', message: 'The connection was disconnected.', retryable: false } })
    .eq('integration_id', connection.id)
    .eq('organization_id', connection.organizationId)
    .in('status', ['proposed', 'awaiting_approval', 'approved'])
    .select('id, task_id')
  if (error) {
    console.error('[integrations] cancelling pending actions failed', redact({ code: error.code }))
    return 0
  }
  const executionIds = (data ?? []).map((row) => row.id)
  if (executionIds.length) {
    await runtime.admin
      .from('approval_requests')
      .update({ status: 'cancelled', decided_at: runtime.now().toISOString(), decision_note: 'The connection was disconnected.' })
      .eq('organization_id', connection.organizationId)
      .in('tool_execution_id', executionIds)
      .eq('status', 'pending')
    await runtime.admin
      .from('tasks')
      .update({ status: 'cancelled', completed_at: runtime.now().toISOString() })
      .eq('organization_id', connection.organizationId)
      .in('id', (data ?? []).map((row) => row.task_id))
      .in('status', ['pending', 'queued', 'running', 'waiting_approval', 'blocked'])
  }
  return executionIds.length
}

/**
 * Connections whose health hasn't been checked recently, across
 * organizations (cron only). Each check afterwards is scoped to its row's
 * organization.
 */
export async function connectionsDueForHealthCheck(runtime: IntegrationRuntime, olderThanMs: number, limit: number) {
  const cutoff = new Date(runtime.now().getTime() - olderThanMs).toISOString()
  const { data, error } = await runtime.admin
    .from('integrations')
    .select('id, organization_id')
    .eq('status', 'connected')
    .or(`last_health_check_at.is.null,last_health_check_at.lt.${cutoff}`)
    .order('last_health_check_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  if (error) {
    console.error('[integrations] listing connections for health checks failed', redact({ code: error.code }))
    return []
  }
  return data ?? []
}

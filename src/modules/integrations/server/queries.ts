// Read models for the integration pages, loaded with the user's session so
// RLS limits them to the active workspace. Credentials are never selected
// (clients can't read integration_secrets or pending inputs at all).

import 'server-only'

import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'

import { CONNECTORS, getConnector, summarizeConnector } from '../connectors/registry'
import type { ApprovalMode, ConnectorSummary, HealthStatus, IntegrationStatus, ProviderKey } from '../domain/types'
import { isConnectorConfigured } from './runtime'

export class IntegrationDataError extends Error {
  override name = 'IntegrationDataError'
}

function fail(what: string, error: { code?: string }): never {
  console.error(`[integrations] loading ${what} failed`, redact({ code: error.code }))
  throw new IntegrationDataError(`We couldn’t load ${what}. Please try again.`)
}

export function listConnectorSummaries(): ConnectorSummary[] {
  return CONNECTORS.map((connector) => summarizeConnector(connector, isConnectorConfigured(connector)))
}

export function getConnectorSummary(provider: string): ConnectorSummary | null {
  const connector = getConnector(provider)
  return connector ? summarizeConnector(connector, isConnectorConfigured(connector)) : null
}

export interface ConnectionView {
  id: string
  provider: ProviderKey
  displayName: string
  accountLabel: string | null
  externalAccountId: string | null
  status: IntegrationStatus
  healthStatus: HealthStatus
  healthMessage: string | null
  lastHealthCheckAt: string | null
  lastError: string | null
  grantedScopes: string[]
  connectedAt: string | null
  revokedAt: string | null
  metadata: Record<string, unknown>
}

const CONNECTION_COLUMNS =
  'id, provider, display_name, external_account_label, external_account_id, status, health_status, health_message, last_health_check_at, last_error, granted_scopes, connected_at, revoked_at, provider_metadata'

type ConnectionRow = {
  id: string
  provider: string
  display_name: string
  external_account_label: string | null
  external_account_id: string | null
  status: string
  health_status: string
  health_message: string | null
  last_health_check_at: string | null
  last_error: string | null
  granted_scopes: string[]
  connected_at: string | null
  revoked_at: string | null
  provider_metadata: unknown
}

function toView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    provider: row.provider as ProviderKey,
    displayName: row.display_name,
    accountLabel: row.external_account_label,
    externalAccountId: row.external_account_id,
    status: row.status as IntegrationStatus,
    healthStatus: row.health_status as HealthStatus,
    healthMessage: row.health_message,
    lastHealthCheckAt: row.last_health_check_at,
    lastError: row.last_error,
    grantedScopes: row.granted_scopes,
    connectedAt: row.connected_at,
    revokedAt: row.revoked_at,
    metadata: (row.provider_metadata ?? {}) as Record<string, unknown>,
  }
}

export async function listConnections(organizationId: string): Promise<ConnectionView[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('integrations')
    .select(CONNECTION_COLUMNS)
    .eq('organization_id', organizationId)
    .in('provider', CONNECTORS.map((connector) => connector.provider))
    .order('created_at')
  if (error) fail('connections', error)
  return (data as ConnectionRow[]).map(toView)
}

export async function getConnection(organizationId: string, integrationId: string): Promise<ConnectionView | null> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('integrations')
    .select(CONNECTION_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('id', integrationId)
    .maybeSingle()
  if (error) fail('the connection', error)
  return data ? toView(data as ConnectionRow) : null
}

export interface ActionSettingView {
  actionKey: string
  enabled: boolean
  approvalMode: ApprovalMode
}

export async function listActionSettings(organizationId: string, integrationId: string): Promise<ActionSettingView[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('integration_actions')
    .select('action_key, enabled, approval_mode')
    .eq('organization_id', organizationId)
    .eq('integration_id', integrationId)
  if (error) fail('action settings', error)
  return data.map((row) => ({ actionKey: row.action_key, enabled: row.enabled, approvalMode: row.approval_mode as ApprovalMode }))
}

export interface ExecutionView {
  id: string
  toolKey: string
  status: string
  policyDecision: string
  policyReason: string | null
  input: unknown
  output: unknown
  error: { code?: string; message?: string } | null
  attemptCount: number
  createdAt: string
  finishedAt: string | null
}

export async function listRecentExecutions(organizationId: string, integrationId: string, limit = 20): Promise<ExecutionView[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('tool_executions')
    .select('id, tool_key, status, policy_decision, policy_reason, input_redacted, output_redacted, error, attempt_count, created_at, finished_at')
    .eq('organization_id', organizationId)
    .eq('integration_id', integrationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) fail('recent actions', error)
  return data.map((row) => ({
    id: row.id,
    toolKey: row.tool_key,
    status: row.status,
    policyDecision: row.policy_decision,
    policyReason: row.policy_reason,
    input: row.input_redacted,
    output: row.output_redacted,
    error: (row.error ?? null) as ExecutionView['error'],
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }))
}

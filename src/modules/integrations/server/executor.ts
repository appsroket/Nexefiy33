// Runs integration actions. Every call goes through the same checks, in order:
//
//  1. the action exists and the caller's role may request actions;
//  2. the input passes the action's schema (validated here, on the server);
//  3. the connection belongs to the caller's organization, is connected, is
//     for the action's provider, and was granted the action's scopes;
//  4. the action is enabled and the decision (connection setting, declared
//     requirement, organization policies) is allow / require_approval / deny;
//  5. the attempt is recorded (task + tool execution) under the caller's
//     idempotency key, so a repeated request returns the first result;
//  6. allowed actions run now; others wait for approval or are refused.
//
// Running re-checks the connection, scopes, setting and input fingerprint, so
// an approval never outlives a disconnection or a changed payload. Provider
// calls get a per-attempt deadline, shared rate limits, and retries only when
// the action's idempotency strategy makes a repeat safe.
//
// The organization always comes from the verified caller (session or task),
// never from a model or the request body.

import 'server-only'

import { createHash } from 'node:crypto'

import { redact } from '@/lib/logging/redact'
import { hasMinRole, type Json, type OrganizationRole } from '@/lib/supabase/types'

import { findAction } from '../connectors/registry'
import type { ActionDefinition, ConnectorDefinition } from '../connectors/types'
import { IntegrationError, isIntegrationError, needsReconnect, type NormalizedError } from '../domain/errors'
import { approverRoleFor, decideAction, evaluatePolicies, MIN_ROLE_TO_RUN_ACTIONS, type PolicyRule, type StoredPolicy } from '../domain/policy'
import { decideRetry } from '../domain/retry'
import type { ApprovalMode } from '../domain/types'
import { getAccessToken, markNeedsReauth } from './credentials'
import { createHttpClient } from './http'
import { createRateLimitGate } from './rate-limit'
import type { IntegrationRuntime } from './runtime'

const EXECUTION_LEASE_MS = 120_000
const DEFAULT_APPROVAL_HOURS = 72

export interface UserActor {
  kind: 'user'
  userId: string
  role: OrganizationRole
}

export interface ExecuteRequest {
  organizationId: string
  integrationId: string
  actionKey: string
  input: unknown
  /** Same key ⇒ same execution: a retried request never runs the action twice. */
  idempotencyKey: string
  actor: UserActor
}

export type ExecuteResult =
  | { status: 'succeeded'; executionId: string; output: unknown }
  | { status: 'awaiting_approval'; executionId: string; approvalRequestId: string }
  | { status: 'denied'; executionId: string; reason: string }
  | { status: 'failed'; executionId: string; error: NormalizedError }
  | { status: 'invalid_input'; issues: { path: string; message: string }[] }
  | { status: 'refused'; error: NormalizedError }
  | { status: 'duplicate'; executionId: string; executionStatus: string; output: unknown }

/** Stable JSON: object keys sorted, so the same input always has the same fingerprint. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Fingerprint of exactly what will run; approvals bind to it. */
export function actionFingerprint(actionKey: string, integrationId: string, input: unknown): string {
  return createHash('sha256').update(canonicalJson({ action: actionKey, integration: integrationId, input }), 'utf8').digest('hex')
}

/** Drops undefined values so the stored input matches its fingerprint after a JSON round trip. */
function plainJson(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function refused(error: IntegrationError): ExecuteResult {
  return { status: 'refused', error: error.toJSON() }
}

interface ConnectionRow {
  id: string
  organization_id: string
  provider: string
  status: string
  external_account_id: string | null
  external_account_label: string | null
  granted_scopes: string[]
  provider_metadata: Json
}

async function loadConnection(runtime: IntegrationRuntime, organizationId: string, integrationId: string): Promise<ConnectionRow | null> {
  const { data, error } = await runtime.admin
    .from('integrations')
    .select('id, organization_id, provider, status, external_account_id, external_account_label, granted_scopes, provider_metadata')
    .eq('id', integrationId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) throw new IntegrationError('unavailable', { message: 'The connection couldn’t be loaded.', mayHaveReachedProvider: false })
  return data
}

/** Connection checks shared by requesting and running an action. */
function checkConnection(connection: ConnectionRow | null, connector: ConnectorDefinition, action: ActionDefinition): IntegrationError | null {
  if (!connection || connection.provider !== connector.provider) return new IntegrationError('not_connected', { message: 'That connection doesn’t exist in this workspace.' })
  if (connection.status !== 'connected') return new IntegrationError(connection.status === 'needs_reauth' ? 'reauth_required' : 'not_connected')
  const missing = action.scopes.filter((scope) => !connection.granted_scopes.includes(scope))
  if (missing.length) {
    return new IntegrationError('insufficient_scope', { message: `The connection wasn’t granted ${missing.join(', ')}. Reconnect it to grant access.` })
  }
  return null
}

async function loadSetting(runtime: IntegrationRuntime, organizationId: string, integrationId: string, actionKey: string) {
  const { data, error } = await runtime.admin
    .from('integration_actions')
    .select('enabled, approval_mode')
    .eq('integration_id', integrationId)
    .eq('organization_id', organizationId)
    .eq('action_key', actionKey)
    .maybeSingle()
  if (error) throw new IntegrationError('unavailable', { message: 'The action settings couldn’t be loaded.', mayHaveReachedProvider: false })
  return { enabled: data?.enabled ?? true, approvalMode: (data?.approval_mode as ApprovalMode | undefined) ?? null }
}

async function loadPolicies(runtime: IntegrationRuntime, organizationId: string): Promise<{ policies: StoredPolicy[]; approvalHours: number }> {
  const { data, error } = await runtime.admin
    .from('organization_policies')
    .select('id, name, policy')
    .eq('organization_id', organizationId)
    .eq('enabled', true)
    .order('priority')
  if (error) throw new IntegrationError('unavailable', { message: 'Workspace policies couldn’t be loaded.', mayHaveReachedProvider: false })
  let approvalHours = DEFAULT_APPROVAL_HOURS
  const policies = (data ?? []).map((row) => {
    const document = (row.policy ?? {}) as { rules?: PolicyRule[]; defaults?: { approvalExpiresInHours?: number } }
    if (typeof document.defaults?.approvalExpiresInHours === 'number') approvalHours = Math.min(approvalHours, document.defaults.approvalExpiresInHours)
    return { id: row.id, name: row.name, rules: Array.isArray(document.rules) ? document.rules : [] }
  })
  return { policies, approvalHours }
}

async function decide(runtime: IntegrationRuntime, organizationId: string, integrationId: string, action: ActionDefinition) {
  const [setting, { policies, approvalHours }] = await Promise.all([
    loadSetting(runtime, organizationId, integrationId, action.key),
    loadPolicies(runtime, organizationId),
  ])
  const decision = decideAction({
    requirement: action.approval,
    risk: action.risk,
    connectionMode: setting.approvalMode,
    enabled: setting.enabled,
    policy: evaluatePolicies(policies, { toolKey: action.key, risk: action.risk }),
  })
  return { ...decision, approvalHours }
}

export async function requestAction(runtime: IntegrationRuntime, request: ExecuteRequest): Promise<ExecuteResult> {
  const found = findAction(request.actionKey)
  if (!found) return refused(new IntegrationError('invalid_input', { message: 'Unknown action.' }))
  const { connector, action } = found
  if (!hasMinRole(request.actor.role, MIN_ROLE_TO_RUN_ACTIONS)) {
    return refused(new IntegrationError('forbidden', { message: 'Your role can’t run integration actions in this workspace.' }))
  }

  const parsed = action.input.safeParse(request.input)
  if (!parsed.success) {
    return {
      status: 'invalid_input',
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    }
  }
  const input = plainJson(parsed.data)

  try {
    const connection = await loadConnection(runtime, request.organizationId, request.integrationId)
    const problem = checkConnection(connection, connector, action)
    if (problem) return refused(problem)

    const decision = await decide(runtime, request.organizationId, request.integrationId, action)
    const fingerprint = actionFingerprint(action.key, request.integrationId, input)
    const summary = action.summarize(parsed.data).slice(0, 500)
    const now = runtime.now()

    // Task: the unit of work this action belongs to (a manual request here).
    const taskKey = `integration:${request.idempotencyKey}`
    const { data: task, error: taskError } = await runtime.admin
      .from('tasks')
      .insert({
        organization_id: request.organizationId,
        title: summary,
        source: 'manual',
        status: decision.decision === 'require_approval' ? 'waiting_approval' : 'running',
        idempotency_key: taskKey,
        max_attempts: 1,
        attempt_count: 1,
        started_at: now.toISOString(),
        created_by: request.actor.userId,
      })
      .select('id')
      .single()
    if (taskError?.code === '23505') return await duplicateResult(runtime, request.organizationId, request.idempotencyKey)
    if (taskError || !task) throw new IntegrationError('unavailable', { message: 'The request couldn’t be recorded.', mayHaveReachedProvider: false })

    const status = decision.decision === 'deny' ? 'skipped' : decision.decision === 'require_approval' ? 'awaiting_approval' : 'executing'
    const { data: execution, error: executionError } = await runtime.admin
      .from('tool_executions')
      .insert({
        organization_id: request.organizationId,
        task_id: task.id,
        integration_id: request.integrationId,
        tool_key: action.key,
        risk_level: action.risk,
        input_redacted: plainJson(action.redactInput ? action.redactInput(parsed.data) : input) as Json,
        input_sha256: fingerprint,
        pending_input: status === 'skipped' ? null : (input as Json),
        status,
        policy_decision: decision.decision,
        policy_reason: decision.reason,
        policy_id: decision.policyId,
        idempotency_key: request.idempotencyKey,
        requested_by: request.actor.userId,
        ...(status === 'executing'
          ? { attempt_count: 1, started_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + EXECUTION_LEASE_MS).toISOString() }
          : {}),
        ...(status === 'skipped' ? { finished_at: now.toISOString() } : {}),
      })
      .select('id')
      .single()
    if (executionError?.code === '23505') return await duplicateResult(runtime, request.organizationId, request.idempotencyKey)
    if (executionError?.code === '23514') {
      // The database refuses inputs that look like credentials (private.jsonb_contains_secret).
      await finishTask(runtime, request.organizationId, task.id, 'cancelled', null)
      return refused(new IntegrationError('invalid_input', { message: 'The input contains something that looks like a password, token or API key, so it wasn’t sent.' }))
    }
    if (executionError || !execution) throw new IntegrationError('unavailable', { message: 'The request couldn’t be recorded.', mayHaveReachedProvider: false })

    if (status === 'skipped') {
      await finishTask(runtime, request.organizationId, task.id, 'skipped', null)
      return { status: 'denied', executionId: execution.id, reason: decision.reason }
    }

    if (status === 'awaiting_approval') {
      const { data: approval, error: approvalError } = await runtime.admin
        .from('approval_requests')
        .insert({
          organization_id: request.organizationId,
          tool_execution_id: execution.id,
          task_id: task.id,
          policy_id: decision.policyId,
          action_summary: summary,
          // Approvers see exactly what will be sent.
          proposed_action: {
            action: action.key,
            actionTitle: `${connector.displayName}: ${action.title}`,
            connection: connection!.external_account_label ?? connector.displayName,
            input,
          } as Json,
          payload_sha256: fingerprint,
          status: 'pending',
          required_role: approverRoleFor(action.risk),
          expires_at: new Date(now.getTime() + decision.approvalHours * 3_600_000).toISOString(),
        })
        .select('id')
        .single()
      if (approvalError || !approval) {
        console.error('[integrations] creating the approval request failed', redact({ code: approvalError?.code }))
        await runtime.admin
          .from('tool_executions')
          .update({ status: 'cancelled', error: { code: 'unavailable', message: 'The approval request couldn’t be created.' } })
          .eq('id', execution.id)
          .eq('organization_id', request.organizationId)
        await finishTask(runtime, request.organizationId, task.id, 'cancelled', null)
        throw new IntegrationError('unavailable', { message: 'The approval request couldn’t be created.', mayHaveReachedProvider: false })
      }
      return { status: 'awaiting_approval', executionId: execution.id, approvalRequestId: approval.id }
    }

    return await runExecution(runtime, { executionId: execution.id, organizationId: request.organizationId, attempt: 1, recovered: false })
  } catch (error) {
    if (isIntegrationError(error)) return refused(error)
    throw error
  }
}

async function duplicateResult(runtime: IntegrationRuntime, organizationId: string, idempotencyKey: string): Promise<ExecuteResult> {
  const { data } = await runtime.admin
    .from('tool_executions')
    .select('id, status, output_redacted')
    .eq('organization_id', organizationId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (!data) return refused(new IntegrationError('conflict', { message: 'This request is already being recorded. Refresh to see it.' }))
  return { status: 'duplicate', executionId: data.id, executionStatus: data.status, output: data.output_redacted }
}

async function finishTask(
  runtime: IntegrationRuntime,
  organizationId: string,
  taskId: string,
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled',
  details: { result?: Record<string, unknown>; error?: NormalizedError } | null,
) {
  const { error } = await runtime.admin
    .from('tasks')
    .update({
      status,
      completed_at: runtime.now().toISOString(),
      ...(details?.result ? { result: details.result as Json } : {}),
      ...(details?.error ? { error: details.error as unknown as Json } : {}),
    })
    .eq('id', taskId)
    .eq('organization_id', organizationId)
    .in('status', ['pending', 'queued', 'running', 'waiting_approval', 'blocked'])
  if (error) console.error('[integrations] updating the task failed', redact({ code: error.code }))
}

async function recordEvent(runtime: IntegrationRuntime, organizationId: string, executionId: string, eventType: string, level: 'info' | 'warn' | 'error', message: string, data: Record<string, unknown> = {}) {
  const { error } = await runtime.admin.from('execution_events').insert({
    organization_id: organizationId,
    tool_execution_id: executionId,
    event_type: eventType,
    level,
    message: message.slice(0, 2000),
    data: redact(data) as Json,
  })
  if (error) console.error('[integrations] recording an execution event failed', redact({ code: error.code }))
}

interface ExecutionRow {
  id: string
  organization_id: string
  task_id: string
  integration_id: string | null
  tool_key: string
  status: string
  input_sha256: string
  pending_input: Json | null
}

/**
 * Runs an execution already in "executing" (leased) state: a freshly allowed
 * request, or one claimed from the queue after approval or a lost lease.
 */
export async function runExecution(
  runtime: IntegrationRuntime,
  claim: { executionId: string; organizationId: string; attempt: number; recovered: boolean },
): Promise<ExecuteResult> {
  const { data: row, error } = await runtime.admin
    .from('tool_executions')
    .select('id, organization_id, task_id, integration_id, tool_key, status, input_sha256, pending_input')
    .eq('id', claim.executionId)
    .eq('organization_id', claim.organizationId)
    .maybeSingle()
  if (error || !row) throw new IntegrationError('unavailable', { message: 'The execution couldn’t be loaded.', mayHaveReachedProvider: false })
  const execution = row as ExecutionRow
  if (execution.status !== 'executing') {
    return { status: 'duplicate', executionId: execution.id, executionStatus: execution.status, output: null }
  }

  const fail = (failure: IntegrationError) => finishExecution(runtime, execution, { error: failure })

  const found = findAction(execution.tool_key)
  if (!found || !execution.integration_id) return fail(new IntegrationError('not_connected', { message: 'The action or its connection no longer exists.' }))
  const { connector, action } = found

  if (claim.recovered && action.idempotency.kind === 'not_idempotent') {
    // The previous attempt stopped mid-flight; it may have reached the provider.
    return fail(new IntegrationError('outcome_unknown'))
  }

  // Re-validate everything: approvals don't survive disconnection, revoked scopes or a changed payload.
  const parsed = action.input.safeParse(execution.pending_input)
  if (!parsed.success || actionFingerprint(action.key, execution.integration_id, plainJson(parsed.data)) !== execution.input_sha256) {
    return fail(new IntegrationError('invalid_input', { message: 'The stored input no longer matches what was requested.' }))
  }
  let connection: ConnectionRow | null
  try {
    connection = await loadConnection(runtime, execution.organization_id, execution.integration_id)
    const problem = checkConnection(connection, connector, action)
    if (problem) return fail(problem)
    const decision = await decide(runtime, execution.organization_id, execution.integration_id, action)
    if (decision.decision === 'deny') return fail(new IntegrationError(decision.policyId ? 'denied_by_policy' : 'action_disabled', { message: decision.reason }))
  } catch (failure) {
    if (isIntegrationError(failure)) return fail(failure)
    throw failure
  }

  const connectionRef = { id: connection!.id, organizationId: connection!.organization_id }
  const connectionInfo = {
    ...connectionRef,
    externalAccountId: connection!.external_account_id ?? '',
    metadata: (connection!.provider_metadata ?? {}) as Record<string, unknown>,
  }
  const gate = createRateLimitGate(runtime.admin, connector, connectionRef)

  let failedAttempts = 0
  let forceRefresh = false
  for (;;) {
    const deadline = AbortSignal.timeout(action.timeoutMs)
    try {
      const accessToken = await getAccessToken(runtime, connector, connectionRef, { force: forceRefresh })
      const http = createHttpClient({
        fetch: runtime.fetch,
        timeoutMs: Math.min(connector.requestTimeoutMs, action.timeoutMs),
        defaultBuckets: [action.rateLimitBucket],
        rateLimit: gate,
        signal: deadline,
      })
      const output = await action.execute({ http, accessToken, connection: connectionInfo, signal: deadline }, parsed.data)
      const checked = action.output.safeParse(output)
      if (!checked.success) {
        throw new IntegrationError('provider_error', { message: `${connector.displayName} returned a response Nexefiy didn’t expect.` })
      }
      return await finishExecution(runtime, execution, { output: checked.data, action })
    } catch (caught) {
      const failure = isIntegrationError(caught)
        ? caught
        : deadline.aborted
          ? new IntegrationError('timeout')
          : (console.error('[integrations] unexpected action failure', redact(caught)), new IntegrationError('provider_error', { message: 'The action failed unexpectedly.' }))
      failedAttempts += 1

      // A rejected token gets one forced renewal before giving up on the connection.
      if (failure.code === 'reauth_required' && !forceRefresh) {
        forceRefresh = true
        continue
      }
      if (needsReconnect(failure.code)) {
        await markNeedsReauth(runtime, connectionRef, failure.message)
        return fail(failure)
      }

      const retry = decideRetry(failure, failedAttempts, action.retry, action.idempotency)
      if (!retry.retry) {
        if (failure.code === 'timeout' && action.idempotency.kind === 'not_idempotent') {
          return fail(new IntegrationError('outcome_unknown', { message: `${connector.displayName} didn’t answer in time, so it’s unknown whether the action happened. Check before retrying.` }))
        }
        return fail(failure)
      }
      await recordEvent(runtime, execution.organization_id, execution.id, 'tool.retrying', 'warn', `Attempt ${failedAttempts} failed (${failure.code}); retrying.`, {
        code: failure.code,
        delayMs: retry.delayMs,
      })
      await runtime.sleep(retry.delayMs)
      await renewLease(runtime, execution)
    }
  }
}

async function renewLease(runtime: IntegrationRuntime, execution: ExecutionRow) {
  await runtime.admin
    .from('tool_executions')
    .update({ lease_expires_at: new Date(runtime.now().getTime() + EXECUTION_LEASE_MS).toISOString() })
    .eq('id', execution.id)
    .eq('organization_id', execution.organization_id)
    .eq('status', 'executing')
}

async function finishExecution(
  runtime: IntegrationRuntime,
  execution: ExecutionRow,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outcome: { output: unknown; action: ActionDefinition<any, any> } | { error: IntegrationError },
): Promise<ExecuteResult> {
  const now = runtime.now().toISOString()
  if ('error' in outcome) {
    const error = outcome.error.toJSON()
    await runtime.admin
      .from('tool_executions')
      .update({ status: 'failed', error: error as unknown as Json, finished_at: now, pending_input: null })
      .eq('id', execution.id)
      .eq('organization_id', execution.organization_id)
      .eq('status', 'executing')
    await finishTask(runtime, execution.organization_id, execution.task_id, 'failed', { error })
    await recordEvent(runtime, execution.organization_id, execution.id, 'tool.failed', 'error', error.message, { code: error.code })
    return { status: 'failed', executionId: execution.id, error }
  }

  const stored = plainJson(outcome.action.redactOutput ? outcome.action.redactOutput(outcome.output) : outcome.output)
  const { data } = await runtime.admin
    .from('tool_executions')
    .update({ status: 'succeeded', output_redacted: stored as Json, finished_at: now, pending_input: null })
    .eq('id', execution.id)
    .eq('organization_id', execution.organization_id)
    .eq('status', 'executing')
    .select('id')
  if (!data?.length) {
    // The lease was lost and someone else finished or failed this execution.
    console.error('[integrations] execution finished after losing its lease', { executionId: execution.id })
  }
  await finishTask(runtime, execution.organization_id, execution.task_id, 'succeeded', { result: { action: execution.tool_key, output: stored } })
  await recordEvent(runtime, execution.organization_id, execution.id, 'tool.succeeded', 'info', 'Action completed.')
  return { status: 'succeeded', executionId: execution.id, output: outcome.output }
}

/** Runs approved executions and recovers abandoned ones (after-response nudge and cron). */
export async function processApprovedExecutions(runtime: IntegrationRuntime, limit = 10): Promise<{ claimed: number; results: ExecuteResult[] }> {
  const { data, error } = await runtime.admin.rpc('claim_tool_executions', { p_limit: limit, p_lease_seconds: EXECUTION_LEASE_MS / 1000 })
  if (error) {
    console.error('[integrations] claiming executions failed', redact({ code: error.code }))
    throw new IntegrationError('unavailable', { message: 'Queued actions couldn’t be claimed.', mayHaveReachedProvider: false })
  }
  const results: ExecuteResult[] = []
  for (const claim of data ?? []) {
    try {
      results.push(
        await runExecution(runtime, {
          executionId: claim.tool_execution_id,
          organizationId: claim.organization_id,
          attempt: claim.attempt,
          recovered: claim.recovered,
        }),
      )
    } catch (failure) {
      console.error('[integrations] running a claimed execution failed; its lease will expire and it will be recovered', redact(failure))
    }
  }
  return { claimed: data?.length ?? 0, results }
}

// Runs integration actions. Every call goes through the same checks, in order:
//
//  1. the action exists and the caller's role may request actions;
//  2. the input passes the action's schema (validated here, on the server);
//  3. the connection belongs to the caller's organization, is connected, is
//     for the action's provider, and was granted the action's scopes;
//  4. the action is enabled and the decision (connection setting, declared
//     requirement and category, workspace policies and allowlists) is
//     allow / require_approval / deny; AI work (employees, workflows) takes
//     no action while the workspace's emergency stop is on;
//  5. the attempt is recorded (task + tool execution) under the caller's
//     idempotency key, so a repeated request returns the first result;
//  6. allowed actions run now; others wait for approval or are refused.
//
// Running re-checks the connection, scopes, setting, policies, emergency stop
// and input fingerprint, and what the approval was bound to (the connected
// account, the approver's role, a separate approver), so an approval never
// outlives a disconnection, a changed payload or a stricter policy. Provider
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
import type { PolicyActor } from '@/modules/governance/domain/policy'
import { isConsequential, roleAtLeast } from '@/modules/governance/domain/risk'
import { GovernanceUnavailableError, loadActivePolicies, loadEmergencyStop } from '@/modules/governance/server/state'

import { decideAction, MIN_ROLE_TO_RUN_ACTIONS, mostRestrictive, type ActionDecision } from '../domain/policy'
import { decideRetry } from '../domain/retry'
import type { ApprovalMode } from '../domain/types'
import { getAccessToken, markNeedsReauth } from './credentials'
import { createHttpClient } from './http'
import { createRateLimitGate } from './rate-limit'
import type { IntegrationRuntime } from './runtime'

const EXECUTION_LEASE_MS = 120_000

export interface UserActor {
  kind: 'user'
  userId: string
  role: OrganizationRole
}

/**
 * An AI employee working on a task. Its authority is the intersection of the
 * task's pinned configuration (checked by the runtime), the grants written
 * when it was activated (employee_tool_permissions, checked here), the
 * connection, and workspace policy; it never acts as the person who assigned
 * the task.
 */
export interface EmployeeActor {
  kind: 'employee'
  employeeId: string
  employeeVersionId: string
  taskId: string
  attemptId: string
  /** The person who assigned the task (recorded as requester). */
  requestedBy: string | null
}

/**
 * A tool-action step of a workflow run. Its authority is the activated
 * version: the step must name exactly this action on this connection, the run
 * must still be going, and the admin who activated the version must still be
 * an admin. The action's own approval rules and workspace policy apply as for
 * anyone else; the step's task (created by the orchestrator) is finished here.
 */
export interface WorkflowActor {
  kind: 'workflow'
  runId: string
  nodeId: string
  /** The step's task (no employee), created by the orchestrator before the request. */
  taskId: string
  workflowVersionId: string
  /** The admin who activated the version. */
  authorizedBy: string
  /** The person who started the run (null for scheduled runs). */
  requestedBy: string | null
}

export interface ExecuteRequest {
  organizationId: string
  integrationId: string
  actionKey: string
  input: unknown
  /** Same key ⇒ same execution: a retried request never runs the action twice. */
  idempotencyKey: string
  actor: UserActor | EmployeeActor | WorkflowActor
  /** A stricter starting point than the action's own rules (e.g. the employee's approval rule); it can only add approval. */
  approvalFloor?: ApprovalMode
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

async function governed<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (error instanceof GovernanceUnavailableError) throw new IntegrationError('unavailable', { message: error.message, mayHaveReachedProvider: false })
    throw error
  }
}

async function decide(
  runtime: IntegrationRuntime,
  organizationId: string,
  integrationId: string,
  action: ActionDefinition,
  actor: PolicyActor,
  employeeId?: string | null,
): Promise<ActionDecision & { policyRevisions: { id: string; revision: number }[] }> {
  const [setting, policies] = await Promise.all([
    loadSetting(runtime, organizationId, integrationId, action.key),
    governed(() => loadActivePolicies(runtime.admin, organizationId)),
  ])
  const decision = decideAction({
    toolKey: action.key,
    requirement: action.approval,
    risk: action.risk,
    category: action.category,
    connectionMode: setting.approvalMode,
    enabled: setting.enabled,
    policies,
    actor,
    employeeId: employeeId ?? null,
  })
  return { ...decision, policyRevisions: policies.map((policy) => ({ id: policy.id, revision: policy.revision })) }
}

/** AI work takes no action while the workspace's emergency stop is on. */
async function emergencyStopError(runtime: IntegrationRuntime, organizationId: string): Promise<IntegrationError | null> {
  const stop = await governed(() => loadEmergencyStop(runtime.admin, organizationId))
  return stop ? new IntegrationError('emergency_stop', { message: `The emergency stop is on in this workspace (${stop.reason}), so AI work takes no actions.` }) : null
}

/**
 * Audit entry for an AI or consequential action: who acted, what, and the
 * decision — references and labels only, never the payload.
 */
async function auditAction(
  runtime: IntegrationRuntime,
  organizationId: string,
  entry: { action: string; executionId: string; toolKey: string; employeeId: string | null; userId: string | null; metadata: Record<string, unknown> },
) {
  const { error } = await runtime.admin.from('audit_logs').insert({
    organization_id: organizationId,
    actor_type: entry.employeeId ? 'employee' : entry.userId ? 'user' : 'system',
    actor_employee_id: entry.employeeId,
    actor_user_id: entry.userId,
    action: entry.action,
    target_table: 'tool_executions',
    target_id: entry.executionId,
    metadata: redact({ tool_key: entry.toolKey, ...entry.metadata }) as Json,
  })
  if (error) console.error('[integrations] writing an audit entry failed', redact({ code: error.code }))
}

/** Applies a floor (the employee's grant, a caller's rule): it may add approval, never remove it. */
function withFloor<T extends { decision: ApprovalMode; reason: string }>(decision: T, floor: ApprovalMode | null | undefined, reason: string): T {
  if (!floor || mostRestrictive(decision.decision, floor) === decision.decision) return decision
  return { ...decision, decision: mostRestrictive(decision.decision, floor), reason }
}

/**
 * An employee may act only while it is active, on a task of its own that is
 * running, with the tool granted on this connection at activation. Returns
 * the grant's decision (a floor) or the reason it may not act.
 */
async function checkEmployeeActor(
  runtime: IntegrationRuntime,
  request: { organizationId: string; integrationId: string; actionKey: string },
  actor: EmployeeActor,
): Promise<{ floor: ApprovalMode } | { error: IntegrationError }> {
  const [employee, task, grant] = await Promise.all([
    runtime.admin.from('ai_employees').select('status').eq('id', actor.employeeId).eq('organization_id', request.organizationId).maybeSingle(),
    runtime.admin.from('tasks').select('status, employee_id, cancel_requested_at').eq('id', actor.taskId).eq('organization_id', request.organizationId).maybeSingle(),
    runtime.admin
      .from('employee_tool_permissions')
      .select('decision')
      .eq('organization_id', request.organizationId)
      .eq('employee_id', actor.employeeId)
      .eq('tool_key', request.actionKey)
      .eq('integration_id', request.integrationId)
      .maybeSingle(),
  ])
  if (employee.error || task.error || grant.error) {
    throw new IntegrationError('unavailable', { message: 'The employee’s permissions couldn’t be checked.', mayHaveReachedProvider: false })
  }
  if (employee.data?.status !== 'active') return { error: new IntegrationError('forbidden', { message: 'This employee isn’t active, so it can’t act.' }) }
  if (!task.data || task.data.employee_id !== actor.employeeId || task.data.status !== 'running') {
    return { error: new IntegrationError('forbidden', { message: 'This task isn’t running for this employee.' }) }
  }
  if (task.data.cancel_requested_at) return { error: new IntegrationError('forbidden', { message: 'This task was cancelled, so it takes no new actions.' }) }
  if (!grant.data) return { error: new IntegrationError('forbidden', { message: 'This employee wasn’t granted that action on this connection.' }) }
  return { floor: grant.data.decision as ApprovalMode }
}

/** Minimum role the activator of a workflow version must keep for its runs to act. */
export const MIN_ROLE_TO_AUTHORIZE_WORKFLOWS: OrganizationRole = 'admin'

/**
 * A workflow step may act only while its run is going and not cancelled, on
 * its own task, with the action and connection its activated version names,
 * and while the version's activator is still an admin.
 */
async function checkWorkflowActor(
  runtime: IntegrationRuntime,
  request: { organizationId: string; integrationId: string; actionKey: string },
  actor: WorkflowActor,
): Promise<IntegrationError | null> {
  const [run, task, member] = await Promise.all([
    runtime.admin
      .from('workflow_runs')
      .select('status, cancel_requested_at, workflow_version_id, authorized_by')
      .eq('id', actor.runId)
      .eq('organization_id', request.organizationId)
      .maybeSingle(),
    runtime.admin.from('tasks').select('status, employee_id, workflow_run_id, node_id').eq('id', actor.taskId).eq('organization_id', request.organizationId).maybeSingle(),
    runtime.admin
      .from('organization_members')
      .select('role, status')
      .eq('organization_id', request.organizationId)
      .eq('user_id', actor.authorizedBy)
      .maybeSingle(),
  ])
  if (run.error || task.error || member.error) {
    throw new IntegrationError('unavailable', { message: 'The workflow’s permissions couldn’t be checked.', mayHaveReachedProvider: false })
  }
  if (!run.data || !['running', 'waiting'].includes(run.data.status) || run.data.cancel_requested_at) {
    return new IntegrationError('forbidden', { message: 'This workflow run isn’t going, so it takes no actions.' })
  }
  if (run.data.workflow_version_id !== actor.workflowVersionId || run.data.authorized_by !== actor.authorizedBy) {
    return new IntegrationError('forbidden', { message: 'This action doesn’t belong to the run’s version.' })
  }
  if (!task.data || task.data.employee_id || task.data.workflow_run_id !== actor.runId || task.data.node_id !== actor.nodeId || task.data.status !== 'running') {
    return new IntegrationError('forbidden', { message: 'This step isn’t running for this workflow.' })
  }
  if (!member.data || member.data.status !== 'active' || !hasMinRole(member.data.role as OrganizationRole, MIN_ROLE_TO_AUTHORIZE_WORKFLOWS)) {
    return new IntegrationError('forbidden', { message: 'The person who activated this workflow version is no longer an admin here, so it can’t act. An admin must activate it again.' })
  }
  const { data: version, error } = await runtime.admin
    .from('workflow_versions')
    .select('graph, graph_schema_version')
    .eq('id', actor.workflowVersionId)
    .eq('organization_id', request.organizationId)
    .maybeSingle()
  if (error) throw new IntegrationError('unavailable', { message: 'The workflow version couldn’t be loaded.', mayHaveReachedProvider: false })
  const nodes = ((version?.graph ?? {}) as { nodes?: { id?: unknown; type?: unknown; config?: { toolKey?: unknown; integrationId?: unknown } }[] }).nodes ?? []
  const node = version?.graph_schema_version === 2 ? nodes.find((item) => item.id === actor.nodeId) : undefined
  if (!node || node.type !== 'tool_action' || node.config?.toolKey !== request.actionKey || node.config?.integrationId !== request.integrationId) {
    return new IntegrationError('forbidden', { message: 'The activated workflow version doesn’t include this action on this connection.' })
  }
  return null
}

export type DecisionPreview =
  | { status: 'ok'; decision: 'allow' | 'require_approval' | 'deny'; reason: string }
  | { status: 'refused'; error: NormalizedError }

/**
 * The decision an action would get on this connection now (connection,
 * scopes, setting and policies), without recording or running anything.
 * Used by the employee test playground; running still goes through
 * requestAction, which repeats every check.
 */
export async function previewActionDecision(
  runtime: IntegrationRuntime,
  request: { organizationId: string; integrationId: string; actionKey: string; employeeId?: string; actor?: PolicyActor },
): Promise<DecisionPreview> {
  const found = findAction(request.actionKey)
  if (!found) return { status: 'refused', error: new IntegrationError('invalid_input', { message: 'Unknown action.' }).toJSON() }
  const { connector, action } = found
  try {
    const connection = await loadConnection(runtime, request.organizationId, request.integrationId)
    const problem = checkConnection(connection, connector, action)
    if (problem) return { status: 'refused', error: problem.toJSON() }
    const actor = request.actor ?? (request.employeeId ? 'employee' : 'workflow')
    const decision = await decide(runtime, request.organizationId, request.integrationId, action, actor, request.employeeId)
    return { status: 'ok', decision: decision.decision, reason: decision.reason }
  } catch (error) {
    if (isIntegrationError(error)) return { status: 'refused', error: error.toJSON() }
    throw error
  }
}

export async function requestAction(runtime: IntegrationRuntime, request: ExecuteRequest): Promise<ExecuteResult> {
  const found = findAction(request.actionKey)
  if (!found) return refused(new IntegrationError('invalid_input', { message: 'Unknown action.' }))
  const { connector, action } = found
  const { actor } = request
  if (actor.kind === 'user' && !hasMinRole(actor.role, MIN_ROLE_TO_RUN_ACTIONS)) {
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

    let grantFloor: ApprovalMode | null = null
    if (actor.kind === 'employee') {
      const checked = await checkEmployeeActor(runtime, request, actor)
      if ('error' in checked) return refused(checked.error)
      grantFloor = checked.floor
    }
    if (actor.kind === 'workflow') {
      const problem = await checkWorkflowActor(runtime, request, actor)
      if (problem) return refused(problem)
    }
    if (actor.kind !== 'user') {
      const stopped = await emergencyStopError(runtime, request.organizationId)
      if (stopped) return refused(stopped)
    }

    const employeeId = actor.kind === 'employee' ? actor.employeeId : null
    let decision = await decide(runtime, request.organizationId, request.integrationId, action, actor.kind === 'user' ? 'person' : actor.kind, employeeId)
    decision = withFloor(decision, grantFloor, 'The employee’s permission for this action.')
    decision = withFloor(
      decision,
      request.approvalFloor,
      actor.kind === 'employee' ? 'The employee’s approval rule for this task.' : actor.kind === 'workflow' ? 'The workflow step always asks for approval.' : 'Requested approval.',
    )
    const fingerprint = actionFingerprint(action.key, request.integrationId, input)
    const summary = action.summarize(parsed.data).slice(0, 500)
    const now = runtime.now()

    // Task: the unit of work this action belongs to. An employee's action
    // belongs to the employee's task, a workflow step's to the step's task;
    // a person's action gets its own task.
    let task: { id: string }
    if (actor.kind === 'employee' || actor.kind === 'workflow') {
      task = { id: actor.taskId }
    } else {
      const taskKey = `integration:${request.idempotencyKey}`
      const { data, error: taskError } = await runtime.admin
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
          created_by: actor.userId,
        })
        .select('id')
        .single()
      if (taskError?.code === '23505') return await duplicateResult(runtime, request.organizationId, request.idempotencyKey)
      if (taskError || !data) throw new IntegrationError('unavailable', { message: 'The request couldn’t be recorded.', mayHaveReachedProvider: false })
      task = data
    }
    const ownsTask = actor.kind !== 'employee'

    const status = decision.decision === 'deny' ? 'skipped' : decision.decision === 'require_approval' ? 'awaiting_approval' : 'executing'
    const { data: execution, error: executionError } = await runtime.admin
      .from('tool_executions')
      .insert({
        organization_id: request.organizationId,
        task_id: task.id,
        integration_id: request.integrationId,
        tool_key: action.key,
        risk_level: action.risk,
        action_category: decision.category,
        risk_tier: decision.tier,
        input_redacted: plainJson(action.redactInput ? action.redactInput(parsed.data) : input) as Json,
        input_sha256: fingerprint,
        pending_input: status === 'skipped' ? null : (input as Json),
        status,
        policy_decision: decision.decision,
        policy_reason: decision.reason,
        policy_id: decision.policyId,
        idempotency_key: request.idempotencyKey,
        requested_by: actor.kind === 'user' ? actor.userId : actor.requestedBy,
        ...(actor.kind === 'employee' ? { employee_id: actor.employeeId, task_attempt_id: actor.attemptId } : {}),
        ...(status === 'executing'
          ? { attempt_count: 1, started_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + EXECUTION_LEASE_MS).toISOString() }
          : {}),
        ...(status === 'skipped' ? { finished_at: now.toISOString() } : {}),
      })
      .select('id')
      .single()
    if (executionError?.code === '23505') return await duplicateResult(runtime, request.organizationId, request.idempotencyKey)
    if (executionError?.code === '55000') {
      // The emergency stop was switched on between the check above and the insert.
      if (ownsTask) await finishTask(runtime, request.organizationId, task.id, 'cancelled', null)
      return refused(new IntegrationError('emergency_stop'))
    }
    if (executionError?.code === '23514') {
      // The database refuses inputs that look like credentials (private.jsonb_contains_secret).
      if (ownsTask) await finishTask(runtime, request.organizationId, task.id, 'cancelled', null)
      return refused(new IntegrationError('invalid_input', { message: 'The input contains something that looks like a password, token or API key, so it wasn’t sent.' }))
    }
    if (executionError || !execution) throw new IntegrationError('unavailable', { message: 'The request couldn’t be recorded.', mayHaveReachedProvider: false })

    const audited = actor.kind !== 'user' || isConsequential(decision.category)
    if (audited) {
      await auditAction(runtime, request.organizationId, {
        action: status === 'skipped' ? 'action.denied' : status === 'awaiting_approval' ? 'action.approval_requested' : 'action.started',
        executionId: execution.id,
        toolKey: action.key,
        employeeId,
        userId: actor.kind === 'user' ? actor.userId : null,
        metadata: { category: decision.category, tier: decision.tier, decision: decision.decision, reason: decision.reason, policy_id: decision.policyId, actor: actor.kind },
      })
    }

    if (status === 'skipped') {
      if (ownsTask) await finishTask(runtime, request.organizationId, task.id, 'skipped', null)
      return { status: 'denied', executionId: execution.id, reason: decision.reason }
    }

    if (status === 'awaiting_approval') {
      const { data: approval, error: approvalError } = await runtime.admin
        .from('approval_requests')
        .insert({
          organization_id: request.organizationId,
          tool_execution_id: execution.id,
          task_id: task.id,
          ...(actor.kind === 'employee' ? { employee_id: actor.employeeId, employee_version_id: actor.employeeVersionId } : {}),
          ...(actor.kind === 'workflow' ? { workflow_run_id: actor.runId, workflow_version_id: actor.workflowVersionId } : {}),
          policy_id: decision.policyId,
          policy_revision: decision.policyRevision,
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
          required_role: decision.approverRole,
          separate_approver: decision.separateApprover,
          action_category: decision.category,
          risk_tier: decision.tier,
          // Checked again before the action runs (see checkApprovalStillHolds).
          binding: {
            connectionAccountId: connection!.external_account_id,
            approverRole: decision.approverRole,
            separateApprover: decision.separateApprover,
            ...(actor.kind === 'employee' ? { employeeVersionId: actor.employeeVersionId } : {}),
            ...(actor.kind === 'workflow' ? { workflowVersionId: actor.workflowVersionId } : {}),
            policies: decision.policyRevisions,
          } as Json,
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
        if (ownsTask) await finishTask(runtime, request.organizationId, task.id, 'cancelled', null)
        throw new IntegrationError('unavailable', { message: 'The approval request couldn’t be created.', mayHaveReachedProvider: false })
      }
      if (actor.kind === 'workflow') {
        // The step waits for the decision; the decision (or its expiry) finishes the task.
        await runtime.admin.from('tasks').update({ status: 'waiting_approval' }).eq('id', task.id).eq('organization_id', request.organizationId).eq('status', 'running')
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
  /** Set when an employee's task owns this execution; the task runtime then finishes the task, not the executor. */
  employee_id: string | null
  integration_id: string | null
  tool_key: string
  status: string
  input_sha256: string
  pending_input: Json | null
  policy_decision: string
  requested_by: string | null
  action_category: string | null
  risk_tier: string | null
}

/**
 * Whether an approved action may still run: the approval is approved and
 * unexpired, the connection is still the account it was approved for, the
 * approver still holds the role the action needs now, and a separate
 * approver (if now required) isn't the requester.
 */
async function checkApprovalStillHolds(
  runtime: IntegrationRuntime,
  execution: ExecutionRow,
  connection: ConnectionRow,
  decision: ActionDecision,
): Promise<IntegrationError | null> {
  const { data: approval, error } = await runtime.admin
    .from('approval_requests')
    .select('id, status, decided_by, expires_at, payload_sha256, binding')
    .eq('tool_execution_id', execution.id)
    .eq('organization_id', execution.organization_id)
    .maybeSingle()
  if (error) throw new IntegrationError('unavailable', { message: 'The approval couldn’t be checked.', mayHaveReachedProvider: false })
  const invalid = (message: string) => new IntegrationError('approval_invalidated', { message })
  if (!approval || approval.status !== 'approved' || !approval.decided_by) return invalid('This action has no valid approval.')
  if (approval.payload_sha256 !== execution.input_sha256) return invalid('The action changed after it was approved.')
  if (new Date(approval.expires_at) <= runtime.now()) return invalid('The approval expired before the action could run.')
  const binding = (approval.binding ?? {}) as { connectionAccountId?: string | null }
  if (binding.connectionAccountId !== undefined && binding.connectionAccountId !== connection.external_account_id) {
    return invalid('The connection now points to a different account than the one that was approved.')
  }
  const { data: approver, error: approverError } = await runtime.admin
    .from('organization_members')
    .select('role, status')
    .eq('organization_id', execution.organization_id)
    .eq('user_id', approval.decided_by)
    .maybeSingle()
  if (approverError) throw new IntegrationError('unavailable', { message: 'The approver couldn’t be checked.', mayHaveReachedProvider: false })
  if (!approver || approver.status !== 'active' || !roleAtLeast(approver.role as OrganizationRole, decision.approverRole)) {
    return invalid(`The person who approved this is no longer ${decision.approverRole === 'owner' ? 'an owner' : `an ${decision.approverRole} or above`} here.`)
  }
  if (decision.separateApprover && execution.requested_by && approval.decided_by === execution.requested_by) {
    return invalid('Workspace policy now requires someone other than the requester to approve this action.')
  }
  return null
}

/** Who an execution acts for: an employee, a workflow step, or a person. */
async function executionActor(runtime: IntegrationRuntime, execution: ExecutionRow): Promise<PolicyActor> {
  if (execution.employee_id) return 'employee'
  const { data, error } = await runtime.admin.from('tasks').select('workflow_run_id').eq('id', execution.task_id).eq('organization_id', execution.organization_id).maybeSingle()
  if (error) throw new IntegrationError('unavailable', { message: 'The execution’s task couldn’t be loaded.', mayHaveReachedProvider: false })
  return data?.workflow_run_id ? 'workflow' : 'person'
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
    .select('id, organization_id, task_id, employee_id, integration_id, tool_key, status, input_sha256, pending_input, policy_decision, requested_by, action_category, risk_tier')
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
    const actor = await executionActor(runtime, execution)
    if (actor !== 'person') {
      const stopped = await emergencyStopError(runtime, execution.organization_id)
      if (stopped) return fail(stopped)
    }
    const decision = await decide(runtime, execution.organization_id, execution.integration_id, action, actor, execution.employee_id)
    if (decision.decision === 'deny') return fail(new IntegrationError(decision.policyId ? 'denied_by_policy' : 'action_disabled', { message: decision.reason }))
    if (execution.policy_decision === 'require_approval') {
      const invalid = await checkApprovalStillHolds(runtime, execution, connection!, decision)
      if (invalid) {
        await auditAction(runtime, execution.organization_id, {
          action: 'approval.invalidated',
          executionId: execution.id,
          toolKey: execution.tool_key,
          employeeId: execution.employee_id,
          userId: null,
          metadata: { reason: invalid.message },
        })
        return fail(invalid)
      }
    }
    if (execution.employee_id) {
      // An approval doesn't outlive the employee's pause or a narrowed grant.
      const [grant, employee] = await Promise.all([
        runtime.admin
          .from('employee_tool_permissions')
          .select('decision')
          .eq('organization_id', execution.organization_id)
          .eq('employee_id', execution.employee_id)
          .eq('tool_key', execution.tool_key)
          .eq('integration_id', execution.integration_id)
          .maybeSingle(),
        runtime.admin.from('ai_employees').select('status').eq('id', execution.employee_id).eq('organization_id', execution.organization_id).maybeSingle(),
      ])
      if (grant.error || employee.error) throw new IntegrationError('unavailable', { message: 'The employee’s permissions couldn’t be checked.', mayHaveReachedProvider: false })
      if (!grant.data || grant.data.decision === 'deny' || employee.data?.status !== 'active') {
        return fail(new IntegrationError('forbidden', { message: 'The employee is no longer active or no longer has this action.' }))
      }
    }
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

/** Outcomes of consequential actions and of every employee action are audited. */
async function auditOutcome(runtime: IntegrationRuntime, execution: ExecutionRow, action: string, metadata: Record<string, unknown>) {
  const consequential = execution.risk_tier !== null && execution.risk_tier !== 'low'
  if (!consequential && !execution.employee_id) return
  await auditAction(runtime, execution.organization_id, {
    action,
    executionId: execution.id,
    toolKey: execution.tool_key,
    employeeId: execution.employee_id,
    userId: execution.employee_id ? null : execution.requested_by,
    metadata: { category: execution.action_category, tier: execution.risk_tier, ...metadata },
  })
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
    if (!execution.employee_id) await finishTask(runtime, execution.organization_id, execution.task_id, 'failed', { error })
    await recordEvent(runtime, execution.organization_id, execution.id, 'tool.failed', 'error', error.message, { code: error.code })
    await auditOutcome(runtime, execution, 'action.failed', { code: error.code })
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
  if (!execution.employee_id) await finishTask(runtime, execution.organization_id, execution.task_id, 'succeeded', { result: { action: execution.tool_key, output: stored } })
  await recordEvent(runtime, execution.organization_id, execution.id, 'tool.succeeded', 'info', 'Action completed.')
  await auditOutcome(runtime, execution, 'action.succeeded', {})
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

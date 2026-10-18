// Runs employee tasks from the Postgres queue.
//
//   claim (claim_employee_tasks: lease + attempt)
//   → load the task, its pinned employee version, the checkpoint
//   → check the employee is still active and the monthly budget
//   → assemble context (first step only)
//   → runEmployee with the live invoker, saving a checkpoint, the trace
//     (execution_events), evidence (task_evidence) and usage (usage_records)
//     after every step, and renewing the lease
//   → settle: wait for approval, wait for a reply, retry, fail, cancel, or
//     verify the result against the platform's own records and finish.
//
// If the server stops mid-task, the lease expires and the next claim starts
// a new attempt from the last checkpoint (tool calls are idempotent per call,
// so nothing already done runs again). Every query is scoped to the task's
// organization.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import type { AdminClient } from '@/lib/supabase/admin'
import type { Database } from '@/lib/supabase/database.types'
import type { Json } from '@/lib/supabase/types'
import { employeeConfigSchema } from '@/modules/employees/domain/schemas'
import type { EmployeeConfig } from '@/modules/employees/domain/types'
import { createLiveToolInvoker } from '@/modules/employees/server/live-invoker'
import { monthlySpendMicros } from '@/modules/employees/server/playground'
import { freshCheckpoint, runEmployee, type EvidenceItem, type RunCheckpoint, type RunEvent, type RunResult } from '@/modules/employees/server/runtime'
import type { IntegrationRuntime } from '@/modules/integrations/server/runtime'
import type { Embedder } from '@/modules/knowledge/server/embeddings'
import { modelForTier } from '@/modules/models/domain/catalog'
import type { ModelGateway } from '@/modules/models/server/gateway'

import { classifyModelFailure, decideTaskRetry, type TaskFailure } from '../domain/failures'
import { scrubSecrets } from '../domain/untrusted'
import { verifyTaskResult, type ObservedAction, type Verification } from '../domain/verification'
import { assembleTaskContext } from './context'

/** Longer than a route's maxDuration (300 s), so a live worker never loses its lease mid-step. */
export const TASK_LEASE_SECONDS = 330

export interface TaskRuntimeDeps {
  admin: AdminClient
  gateway: ModelGateway
  integrations: IntegrationRuntime | null
  embedder: Embedder | null
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export interface TaskClaim {
  task_id: string
  organization_id: string
  attempt_id: string
  attempt_number: number
  new_attempt: boolean
  recovered: boolean
}

export type TaskRunStatus = 'succeeded' | 'failed' | 'waiting_approval' | 'blocked' | 'queued' | 'cancelled'

export interface TaskRunSummary {
  taskId: string
  status: TaskRunStatus
  failure?: TaskFailure
  verification?: Verification
}

class CheckpointError extends Error {
  constructor(readonly code: string) {
    super('The task’s checkpoint couldn’t be saved.')
  }
}

const ACTIVE_EXECUTION_STATUSES = ['proposed', 'awaiting_approval', 'approved', 'executing']

export async function processEmployeeTasks(deps: TaskRuntimeDeps, limit = 3): Promise<{ claimed: number; results: TaskRunSummary[] }> {
  const { data, error } = await deps.admin.rpc('claim_employee_tasks', { p_limit: limit, p_lease_seconds: TASK_LEASE_SECONDS })
  if (error) {
    console.error('[tasks] claiming tasks failed', redact({ code: error.code }))
    throw new Error('Queued tasks couldn’t be claimed.')
  }
  const results: TaskRunSummary[] = []
  for (const claim of (data ?? []) as TaskClaim[]) {
    try {
      results.push(await runClaimedTask(deps, claim))
    } catch (failure) {
      // The lease expires and the task is recovered from its last checkpoint.
      console.error('[tasks] running a claimed task failed; it will be recovered', redact(failure))
    }
  }
  return { claimed: data?.length ?? 0, results }
}

export async function runClaimedTask(deps: TaskRuntimeDeps, claim: TaskClaim): Promise<TaskRunSummary> {
  const { admin } = deps
  const now = deps.now ?? (() => new Date())
  const organizationId = claim.organization_id
  const taskId = claim.task_id
  const attemptId = claim.attempt_id

  const event = async (eventType: string, level: 'info' | 'warn' | 'error', message: string, data: Record<string, unknown> = {}) => {
    const { error } = await admin.from('execution_events').insert({
      organization_id: organizationId,
      task_id: taskId,
      event_type: eventType,
      level,
      message: scrubSecrets(message).slice(0, 2000),
      data: redact({ attempt: claim.attempt_number, ...data }) as Json,
    })
    if (error) console.error('[tasks] recording a task event failed', redact({ code: error.code }))
  }

  const { data: task, error: taskError } = await admin
    .from('tasks')
    .select('id, organization_id, employee_id, employee_version_id, title, instructions, max_attempts, created_by, cancel_requested_at')
    .eq('id', taskId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (taskError) throw new Error('The task couldn’t be loaded.')
  if (!task || !task.employee_id || !task.employee_version_id) {
    return await settleFailure(deps, claim, { code: 'not_found', class: 'permanent', message: 'The task, its employee or its version no longer exists.' }, null, event)
  }
  if (claim.recovered) await event('task.recovered', 'warn', 'Continuing after the previous server stopped.')

  const [{ data: employee, error: employeeError }, { data: version, error: versionError }, { data: organization }] = await Promise.all([
    admin.from('ai_employees').select('id, name, status').eq('id', task.employee_id).eq('organization_id', organizationId).maybeSingle(),
    admin
      .from('employee_versions')
      .select('id, version, instructions, config, config_schema_version')
      .eq('id', task.employee_version_id)
      .eq('employee_id', task.employee_id)
      .eq('organization_id', organizationId)
      .maybeSingle(),
    admin.from('organizations').select('name').eq('id', organizationId).maybeSingle(),
  ])
  if (employeeError || versionError) throw new Error('The employee couldn’t be loaded.')
  if (!employee || employee.status !== 'active') {
    return await settleCancelled(deps, claim, { code: 'employee_inactive', class: 'permanent', message: 'The employee was paused or archived, so the task stopped.' }, null, event)
  }
  const parsedConfig = version?.config_schema_version === 2 ? employeeConfigSchema.safeParse(version.config) : null
  if (!version || !parsedConfig?.success) {
    return await settleFailure(deps, claim, { code: 'invalid_configuration', class: 'permanent', message: 'The employee’s pinned version can’t be run (older configuration format).' }, null, event)
  }
  const config: EmployeeConfig = parsedConfig.data

  const { data: attempts, error: attemptsError } = await admin
    .from('task_attempts')
    .select('id, attempt_number, checkpoint')
    .eq('task_id', taskId)
    .eq('organization_id', organizationId)
    .order('attempt_number', { ascending: false })
  if (attemptsError) throw new Error('The task’s attempts couldn’t be loaded.')
  const saved = ((attempts ?? []).find((attempt) => attempt.checkpoint) ?? null)?.checkpoint as RunCheckpoint | null | undefined
  let checkpoint: RunCheckpoint | null = saved && saved.version === 1 ? saved : null

  const spent = await monthlySpendMicros(admin, organizationId, task.employee_id, now())
  const budgetMicros = Math.round(config.budget.monthlyUsd * 1_000_000)
  if (spent >= budgetMicros) {
    return await settleFailure(deps, claim, { code: 'budget_exhausted', class: 'limit', message: 'The employee has used its monthly budget.' }, null, event)
  }

  const context = await assembleTaskContext(
    admin,
    deps.embedder,
    { organizationId, organizationName: organization?.name ?? null, title: task.title, instructions: task.instructions, knowledge: config.knowledge, prefetch: !checkpoint },
    now(),
  )
  if (!checkpoint) {
    checkpoint = freshCheckpoint(context.input, modelForTier(config.model.tier).id)
    checkpoint.suspiciousContentSeen = context.suspicious
    await recordEvidence(admin, organizationId, taskId, attemptId, context.evidence)
    await event('task.started', 'info', 'The employee started the task.', { employee_version: version.version, prefetched_passages: context.evidence.length })
  } else if (claim.new_attempt) {
    await event('task.retrying', 'info', `Attempt ${claim.attempt_number} continues from the last checkpoint.`)
  } else {
    await event('task.resumed', 'info', 'The task continues.')
  }

  const invoker = createLiveToolInvoker({
    organizationId,
    actor: {
      kind: 'employee',
      employeeId: task.employee_id,
      employeeVersionId: task.employee_version_id,
      taskId,
      attemptId,
      requestedBy: task.created_by,
    },
    knowledge: config.knowledge,
    admin,
    embedder: deps.embedder,
    integrations: deps.integrations,
  })

  const leaseUntil = () => new Date(now().getTime() + TASK_LEASE_SECONDS * 1000).toISOString()

  let result: RunResult
  try {
    result = await runEmployee(
      {
        employeeName: employee.name,
        organizationName: organization?.name ?? null,
        instructions: version.instructions,
        config,
        input: context.input,
        businessContext: context.businessContext,
        budgetRemainingMicros: budgetMicros - spent,
        mode: 'live',
        checkpoint,
      },
      {
        gateway: deps.gateway,
        invoker,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        hooks: {
          async checkpoint(state) {
            const { error } = await admin
              .from('task_attempts')
              .update({
                checkpoint: state as unknown as Json,
                checkpoint_at: now().toISOString(),
                turn_count: state.turns,
                tool_call_count: state.toolCalls.length,
                cost_micros: state.costMicros,
                model: state.model,
                model_input_tokens: state.usage.inputTokens,
                model_output_tokens: state.usage.outputTokens,
                active_ms: state.activeMs,
              })
              .eq('id', attemptId)
              .eq('organization_id', organizationId)
              .eq('status', 'running')
            if (error) throw new CheckpointError(error.code ?? 'unknown')
            await admin
              .from('tasks')
              .update({ lease_expires_at: leaseUntil() })
              .eq('id', taskId)
              .eq('organization_id', organizationId)
              .eq('status', 'running')
          },
          async event(runEvent) {
            await recordRunEvent(admin, organizationId, taskId, attemptId, task.employee_id!, runEvent, event)
          },
          async shouldStop() {
            const [{ data: current }, { data: currentEmployee }] = await Promise.all([
              admin.from('tasks').select('cancel_requested_at').eq('id', taskId).eq('organization_id', organizationId).maybeSingle(),
              admin.from('ai_employees').select('status').eq('id', task.employee_id!).eq('organization_id', organizationId).maybeSingle(),
            ])
            return Boolean(current?.cancel_requested_at) || currentEmployee?.status !== 'active'
          },
        },
      },
    )
  } catch (error) {
    const failure: TaskFailure =
      error instanceof CheckpointError
        ? error.code === '23514'
          ? { code: 'not_recorded', class: 'permanent', message: 'The task’s progress couldn’t be saved (it contained something credential-shaped), so it stopped.' }
          : { code: 'checkpoint_failed', class: 'transient', message: 'The task’s progress couldn’t be saved.' }
        : { code: 'internal', class: 'transient', message: 'The task stopped unexpectedly.' }
    if (!(error instanceof CheckpointError)) console.error('[tasks] the employee runtime failed', redact(error))
    return await settleFailure(deps, claim, failure, null, event, task.max_attempts)
  }

  return await settle(deps, claim, task.max_attempts, result, event)
}

type EventWriter = (eventType: string, level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => Promise<void>

async function recordEvidence(admin: AdminClient, organizationId: string, taskId: string, attemptId: string, items: readonly EvidenceItem[]) {
  if (!items.length) return
  const { error } = await admin.from('task_evidence').insert(
    items.map((item) => ({
      organization_id: organizationId,
      task_id: taskId,
      task_attempt_id: attemptId,
      kind: item.kind,
      tool_key: item.toolKey ?? null,
      tool_execution_id: item.executionId ?? null,
      knowledge_source_id: item.sourceId ?? null,
      knowledge_chunk_id: item.chunkId ?? null,
      label: item.label?.slice(0, 64) ?? null,
      title: scrubSecrets(item.title).slice(0, 300) || 'Evidence',
      excerpt: scrubSecrets(item.excerpt).slice(0, 4000),
      suspected_instructions: item.suspicious,
    })),
  )
  if (error) console.error('[tasks] recording evidence failed', redact({ code: error.code }))
}

async function recordRunEvent(admin: AdminClient, organizationId: string, taskId: string, attemptId: string, employeeId: string, runEvent: RunEvent, event: EventWriter) {
  switch (runEvent.type) {
    case 'model_turn': {
      await event('model.turn', 'info', `Step ${runEvent.turn}: ${runEvent.model} (${runEvent.stopReason}).`, {
        turn: runEvent.turn,
        model: runEvent.model,
        input_tokens: runEvent.inputTokens,
        output_tokens: runEvent.outputTokens,
        cost_micros: runEvent.costMicros,
        stop_reason: runEvent.stopReason,
        duration_ms: runEvent.durationMs,
      })
      // Spend is recorded per step, so a stopped server never loses it.
      const common = { organization_id: organizationId, employee_id: employeeId, task_id: taskId, provider: 'anthropic', model: runEvent.model, occurred_at: new Date().toISOString() }
      const key = `task:${attemptId}:turn:${runEvent.turn}`
      const { error } = await admin.from('usage_records').upsert(
        [
          { ...common, metric: 'model_cost', quantity: 1, cost_micros: runEvent.costMicros, currency: 'USD', idempotency_key: `${key}:cost` },
          { ...common, metric: 'model_input_tokens', quantity: runEvent.inputTokens, idempotency_key: `${key}:input` },
          { ...common, metric: 'model_output_tokens', quantity: runEvent.outputTokens, idempotency_key: `${key}:output` },
        ],
        { onConflict: 'organization_id,idempotency_key', ignoreDuplicates: true },
      )
      if (error) console.error('[tasks] recording usage failed', redact({ code: error.code }))
      return
    }
    case 'model_retry':
      await event('model.retry', 'warn', `The model call failed (${runEvent.code}); retry ${runEvent.retry} in ${Math.round(runEvent.delayMs / 1000)} s.`, {
        code: runEvent.code,
        retry: runEvent.retry,
      })
      return
    case 'tool_call':
      await event(
        'tool.called',
        runEvent.isError ? 'warn' : 'info',
        `${runEvent.toolKey}: ${runEvent.executed ? 'ran' : runEvent.decision === 'require_approval' ? 'waiting for approval' : runEvent.decision === 'deny' ? 'blocked' : 'not run'}${runEvent.isError ? ' (error)' : ''}.`,
        {
          tool_key: runEvent.toolKey,
          decision: runEvent.decision,
          executed: runEvent.executed,
          is_error: runEvent.isError,
          execution_id: runEvent.executionId ?? null,
          turn: runEvent.turn,
        },
      )
      if (runEvent.suspicious) {
        await event('tool.suspicious_content', 'warn', `The result of ${runEvent.toolKey} contains text that looks like instructions; it was treated as data and later changes need approval.`, {
          tool_key: runEvent.toolKey,
        })
      }
      await recordEvidence(admin, organizationId, taskId, attemptId, runEvent.evidence)
      return
    case 'approval_result':
      await event('tool.approval_result', runEvent.isError ? 'warn' : 'info', `${runEvent.toolKey}: ${runEvent.executed ? 'ran after approval' : 'did not run'}.`, {
        tool_key: runEvent.toolKey,
        execution_id: runEvent.executionId,
        executed: runEvent.executed,
      })
      await recordEvidence(admin, organizationId, taskId, attemptId, runEvent.evidence)
  }
}

async function loadObservedActions(admin: AdminClient, organizationId: string, taskId: string): Promise<ObservedAction[]> {
  const { data, error } = await admin.from('tool_executions').select('id, tool_key, risk_level, status, error').eq('task_id', taskId).eq('organization_id', organizationId)
  if (error) throw new Error('The task’s actions couldn’t be loaded.')
  return (data ?? []).map((row) => ({
    executionId: row.id,
    toolKey: row.tool_key,
    risk: row.risk_level as ObservedAction['risk'],
    status: row.status,
    errorCode: ((row.error ?? null) as { code?: string } | null)?.code ?? null,
  }))
}

function attemptUsage(result: RunResult) {
  return {
    turn_count: result.checkpoint.turns,
    tool_call_count: result.checkpoint.toolCalls.length,
    cost_micros: result.costMicros,
    model: result.model,
    model_input_tokens: result.usage.inputTokens,
    model_output_tokens: result.usage.outputTokens,
    active_ms: result.checkpoint.activeMs,
  }
}

async function finishAttempt(
  deps: TaskRuntimeDeps,
  claim: TaskClaim,
  status: 'succeeded' | 'failed' | 'cancelled',
  error: TaskFailure | null,
  result: RunResult | null,
) {
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const { error: updateError } = await deps.admin
    .from('task_attempts')
    .update({ status, finished_at: now, ...(error ? { error: error as unknown as Json } : {}), ...(result ? attemptUsage(result) : {}) })
    .eq('id', claim.attempt_id)
    .eq('organization_id', claim.organization_id)
    .eq('status', 'running')
  if (updateError) console.error('[tasks] finishing an attempt failed', redact({ code: updateError.code }))
}

async function updateTask(deps: TaskRuntimeDeps, claim: TaskClaim, values: Database['public']['Tables']['tasks']['Update']) {
  const { data, error } = await deps.admin
    .from('tasks')
    .update(values)
    .eq('id', claim.task_id)
    .eq('organization_id', claim.organization_id)
    .eq('status', 'running')
    .select('id')
  if (error) {
    console.error('[tasks] updating a task failed', redact({ code: error.code }))
    throw new Error('The task couldn’t be updated.')
  }
  return (data ?? []).length > 0
}

function taskResult(result: RunResult, extra: Record<string, unknown>): Json {
  return {
    outcome: result.outcome,
    reply: result.reply.slice(0, 20_000),
    report: result.report,
    model: result.model,
    usage: result.usage,
    costMicros: result.costMicros,
    turns: result.checkpoint.turns,
    toolCalls: result.checkpoint.toolCalls.length,
    ...extra,
  } as unknown as Json
}

async function settleFailure(
  deps: TaskRuntimeDeps,
  claim: TaskClaim,
  failure: TaskFailure,
  run: RunResult | null,
  event: EventWriter,
  maxAttempts = 1,
): Promise<TaskRunSummary> {
  const retry = decideTaskRetry(failure, claim.attempt_number, maxAttempts)
  await finishAttempt(deps, claim, 'failed', failure, run)
  if (retry.retry) {
    const at = new Date((deps.now ?? (() => new Date()))().getTime() + retry.delayMs).toISOString()
    await updateTask(deps, claim, { status: 'queued', lease_expires_at: null, scheduled_at: at, error: failure as unknown as Json })
    await event('task.retry_scheduled', 'warn', `${failure.message} Retrying in ${Math.round(retry.delayMs / 1000)} s (attempt ${claim.attempt_number + 1} of ${maxAttempts}).`, {
      code: failure.code,
      class: failure.class,
    })
    return { taskId: claim.task_id, status: 'queued', failure }
  }
  await updateTask(deps, claim, {
    status: 'failed',
    lease_expires_at: null,
    completed_at: (deps.now ?? (() => new Date()))().toISOString(),
    error: failure as unknown as Json,
    ...(run ? { result: taskResult(run, {}) } : {}),
  })
  await event('task.failed', 'error', failure.message, { code: failure.code, class: failure.class })
  return { taskId: claim.task_id, status: 'failed', failure }
}

async function settleCancelled(deps: TaskRuntimeDeps, claim: TaskClaim, failure: TaskFailure | null, result: RunResult | null, event: EventWriter): Promise<TaskRunSummary> {
  await finishAttempt(deps, claim, 'cancelled', failure, result)
  await updateTask(deps, claim, {
    status: 'cancelled',
    lease_expires_at: null,
    completed_at: (deps.now ?? (() => new Date()))().toISOString(),
    ...(failure ? { error: failure as unknown as Json } : {}),
    ...(result ? { result: taskResult(result, {}) } : {}),
  })
  await event('task.cancelled', 'info', failure?.message ?? 'Task cancelled.')
  return { taskId: claim.task_id, status: 'cancelled', ...(failure ? { failure } : {}) }
}

async function settle(deps: TaskRuntimeDeps, claim: TaskClaim, maxAttempts: number, result: RunResult, event: EventWriter): Promise<TaskRunSummary> {
  const { admin } = deps
  const stoppedReason = [...result.transcript].reverse().find((entry) => entry.kind === 'stopped')
  const reason = stoppedReason?.kind === 'stopped' ? stoppedReason.reason : null

  switch (result.outcome) {
    case 'waiting_approval': {
      await admin.from('task_attempts').update(attemptUsage(result)).eq('id', claim.attempt_id).eq('organization_id', claim.organization_id)
      await updateTask(deps, claim, { status: 'waiting_approval', lease_expires_at: null, result: taskResult(result, {}) })
      // A decision made while the step was still running found the task
      // running and didn't re-queue it; check again now that it waits.
      const { data: pending } = await admin
        .from('tool_executions')
        .select('id')
        .eq('task_id', claim.task_id)
        .eq('organization_id', claim.organization_id)
        .in('status', ACTIVE_EXECUTION_STATUSES)
      if (!pending?.length) {
        await admin.from('tasks').update({ status: 'queued' }).eq('id', claim.task_id).eq('organization_id', claim.organization_id).eq('status', 'waiting_approval')
        return { taskId: claim.task_id, status: 'queued' }
      }
      await event('task.waiting_approval', 'info', `Waiting for approval of ${pending.length} action(s).`)
      return { taskId: claim.task_id, status: 'waiting_approval' }
    }

    case 'escalated': {
      const escalation = [...result.transcript].reverse().find((entry) => entry.kind === 'escalation')
      await admin.from('task_attempts').update(attemptUsage(result)).eq('id', claim.attempt_id).eq('organization_id', claim.organization_id)
      await updateTask(deps, claim, {
        status: 'blocked',
        lease_expires_at: null,
        result: taskResult(result, { escalation: escalation?.kind === 'escalation' ? { reason: escalation.reason, message: escalation.message } : null }),
      })
      await event('task.escalated', 'warn', escalation?.kind === 'escalation' ? `Escalated: ${escalation.reason}` : 'Escalated.')
      return { taskId: claim.task_id, status: 'blocked' }
    }

    case 'cancelled':
      return await settleCancelled(deps, claim, null, result, event)

    case 'limit_reached':
      return await settleFailure(deps, claim, { code: 'limit_reached', class: 'limit', message: reason ?? 'The task reached one of its limits.' }, result, event, maxAttempts)

    case 'refused':
      return await settleFailure(deps, claim, { code: 'refused', class: 'task', message: 'The model declined this task.' }, result, event, maxAttempts)

    case 'error': {
      const code = result.error?.code ?? 'unknown'
      return await settleFailure(deps, claim, { code, class: classifyModelFailure(code), message: result.error?.message ?? 'The model call failed.' }, result, event, maxAttempts)
    }

    case 'completed': {
      const actions = await loadObservedActions(admin, claim.organization_id, claim.task_id)
      const verification = verifyTaskResult({ report: result.report, reply: result.reply, actions })
      await event('task.verified', verification.status === 'failed' ? 'error' : verification.status === 'needs_review' ? 'warn' : 'info', `Verification: ${verification.status}.`, {
        status: verification.status,
        checks: verification.checks.map((check) => ({ key: check.key, status: check.status })),
      })
      const resultJson = taskResult(result, {
        verification,
        actions: actions.map((action) => ({ executionId: action.executionId, toolKey: action.toolKey, status: action.status, risk: action.risk })),
      })

      const failure: TaskFailure | null =
        verification.status === 'failed'
          ? { code: 'verification_failed', class: 'task', message: 'The employee’s report doesn’t match what actually happened.' }
          : result.report?.status === 'not_completed'
            ? { code: 'not_completed', class: 'task', message: 'The employee reported that it couldn’t complete the task.' }
            : null
      const completedAt = (deps.now ?? (() => new Date()))().toISOString()
      if (failure) {
        await finishAttempt(deps, claim, 'failed', failure, result)
        await updateTask(deps, claim, { status: 'failed', lease_expires_at: null, completed_at: completedAt, error: failure as unknown as Json, result: resultJson })
        await event('task.failed', 'error', failure.message, { code: failure.code, class: failure.class })
        return { taskId: claim.task_id, status: 'failed', failure, verification }
      }

      await finishAttempt(deps, claim, 'succeeded', null, result)
      await updateTask(deps, claim, { status: 'succeeded', lease_expires_at: null, completed_at: completedAt, error: null, result: resultJson })
      const { data: task } = await admin.from('tasks').select('employee_id').eq('id', claim.task_id).eq('organization_id', claim.organization_id).maybeSingle()
      await admin.from('usage_records').upsert(
        [{ organization_id: claim.organization_id, metric: 'task_completed', quantity: 1, task_id: claim.task_id, employee_id: task?.employee_id ?? null, idempotency_key: `task:${claim.task_id}:completed` }],
        { onConflict: 'organization_id,idempotency_key', ignoreDuplicates: true },
      )
      await event('task.succeeded', 'info', verification.status === 'verified' ? 'Task completed and verified.' : 'Task completed; some checks need review.')
      return { taskId: claim.task_id, status: 'succeeded', verification }
    }
  }
}

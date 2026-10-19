// Durable execution against a real PostgreSQL with every migration applied:
// the real runner, executor, dispatcher and SQL functions together, with a
// scripted model and a fake HubSpot (no live model or provider call).
//
// Persistence: what a task did is in the database after every step.
// Recovery: a worker that dies mid-task is replaced from the last checkpoint,
//   no action runs twice, and the dead worker can't write when it wakes.
// Cancellation: stops future work at once, withdraws pending approvals,
//   skips dependent tasks, and leaves completed actions recorded as done.
// History: every state change is in the task's events.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModelError, type ModelGateway, type ModelTurnRequest, type ModelTurnResult } from '@/modules/models/server/gateway'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import { dispatchDueTasks } from '@/modules/tasks/server/dispatch'
import { processEmployeeTasks, type TaskRuntimeDeps } from '@/modules/tasks/server/runner'

import { jsonResponse } from '../helpers/integration-fixtures'
import { createTestDatabase, EMPLOYEE, LOCAL_DB, OPERATOR, OTHER_OWNER, OWNER, SEARCH_URL, seedSalesEmployee, UPSERT_URL, VIEWER, type TestDatabase } from './database'

type Step = Partial<ModelTurnResult> | Error | ((request: ModelTurnRequest) => Partial<ModelTurnResult> | Promise<Partial<ModelTurnResult>>)

function scriptedModel(steps: Step[]): ModelGateway & { requests: ModelTurnRequest[] } {
  const requests: ModelTurnRequest[] = []
  return {
    provider: 'anthropic',
    requests,
    turn: vi.fn(async (request: ModelTurnRequest) => {
      requests.push({ ...request, messages: [...request.messages] })
      const next = steps.shift()
      if (!next) throw new Error('no more scripted steps')
      if (next instanceof Error) throw next
      const step = typeof next === 'function' ? await next(request) : next
      return { text: '', toolCalls: [], stopReason: 'end_turn' as const, model: 'claude-sonnet-5-5', usage: { inputTokens: 2000, outputTokens: 200 }, assistantContent: [], ...step }
    }),
    structured: vi.fn(),
  }
}

const search = (id = 'call-search') => ({ toolCalls: [{ id, name: 'hubspot__contacts__search', input: { email: 'dana@example.com' } }], stopReason: 'tool_use' as const })
const upsert = (id = 'call-upsert') => ({ toolCalls: [{ id, name: 'hubspot__contacts__upsert', input: { email: 'new@example.com', firstName: 'New' } }], stopReason: 'tool_use' as const })
const finish = (receipts: () => Promise<string[]> | string[], summary = 'Dana is already in HubSpot.') => async () => ({
  toolCalls: [{ id: 'call-finish', name: 'finish_task', input: { status: 'completed', summary, receipts: await receipts() } }],
  stopReason: 'tool_use' as const,
})
const searchOk = () => jsonResponse(200, { total: 1, results: [{ id: '501', properties: { email: 'dana@example.com', firstname: 'Dana' } }] })
const upsertOk = () => jsonResponse(201, { id: '901', properties: { email: 'new@example.com' } })

let db: TestDatabase

beforeEach(async () => {
  if (!LOCAL_DB) return
  db = await createTestDatabase()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (LOCAL_DB) await db.close()
})

async function setup(steps: Step[], limits: Record<string, number> = {}) {
  const seeded = await seedSalesEmployee(db, [[SEARCH_URL, searchOk], [UPSERT_URL, upsertOk]], limits)
  const model = scriptedModel(steps)
  const deps: TaskRuntimeDeps = { admin: db.admin as never, gateway: model, integrations: seeded.runtime, embedder: null, sleep: async () => {} }
  return { ...seeded, model, deps }
}

async function assign(title: string, options: { key?: string; priority?: number; dependsOn?: string[]; timeoutMinutes?: number } = {}) {
  const { data, error } = await db.as(OPERATOR).rpc('assign_employee_task', {
    p_employee_id: EMPLOYEE,
    p_title: title,
    p_instructions: 'Check the CRM.',
    p_idempotency_key: options.key ?? `key-${Math.random().toString(36).slice(2, 12)}`,
    p_priority: options.priority ?? 0,
    p_depends_on: options.dependsOn ?? [],
    p_timeout_minutes: options.timeoutMinutes ?? 4320,
  })
  expect(error).toBeNull()
  return data as string
}

/** The engine's dispatch with an inline "job" per due task. */
async function dispatch(deps: TaskRuntimeDeps) {
  const outcomes: string[] = []
  const result = await dispatchDueTasks({
    admin: deps.admin,
    integrations: deps.integrations,
    start: async (due) => {
      for (const task of due) for (const run of (await processEmployeeTasks(deps, 1, task.taskId)).results) outcomes.push(run.status)
    },
  })
  return { ...result, outcomes }
}

const taskRow = async (id: string) => (await db.sql<Record<string, unknown>>('select * from public.tasks where id = $1', [id]))[0]!
const events = async (id: string) => (await db.sql<{ event_type: string }>('select event_type from public.execution_events where task_id = $1 order by id', [id])).map((row) => row.event_type)
const executions = (id: string) => db.sql<{ id: string; tool_key: string; status: string; idempotency_key: string }>('select * from public.tool_executions where task_id = $1 order by created_at', [id])
const attemptsOf = (id: string) => db.sql<Record<string, unknown>>('select * from public.task_attempts where task_id = $1 order by attempt_number', [id])

describe.skipIf(!LOCAL_DB)('durable execution on PostgreSQL', () => {
  it('persists every step: attempt, checkpoint, actions, evidence, usage and history, verified against the records', async () => {
    const { deps, requests } = await setup([search(), finish(async () => (await executions(taskId)).map((row) => row.id))])
    const taskId = await assign('Is Dana in HubSpot?')
    const run = await dispatch(deps)
    expect(run.outcomes).toEqual(['succeeded'])

    const task = await taskRow(taskId)
    expect(task).toMatchObject({ status: 'succeeded', lease_expires_at: null, attempt_count: 1 })
    expect(task.result).toMatchObject({ verification: { status: 'verified' } })
    const [attempt] = await attemptsOf(taskId)
    expect(attempt).toMatchObject({ status: 'succeeded', turn_count: 2, tool_call_count: 1 })
    expect(attempt!.checkpoint).toMatchObject({ version: 1, turns: 2 })
    expect(Number(attempt!.cost_micros)).toBeGreaterThan(0)
    expect(await executions(taskId)).toEqual([expect.objectContaining({ tool_key: 'hubspot.contacts.search', status: 'succeeded', idempotency_key: `task:${taskId}:call-search` })])
    expect(requests).toHaveLength(1)
    expect(await db.sql('select kind from public.task_evidence where task_id = $1', [taskId])).toEqual([{ kind: 'tool_result' }])
    const usage = await db.sql<{ metric: string }>('select metric from public.usage_records where task_id = $1', [taskId])
    expect(usage.map((row) => row.metric)).toEqual(expect.arrayContaining(['model_cost', 'model_input_tokens', 'task_completed']))
    expect(await events(taskId)).toEqual(expect.arrayContaining(['task.queued', 'task.started', 'model.turn', 'tool.called', 'task.verified', 'task.succeeded']))

    // Members read the history; another organization doesn't see the task at all.
    expect((await db.as(VIEWER).from('execution_events').select('event_type').eq('task_id', taskId)).data).not.toHaveLength(0)
    expect((await db.as(OTHER_OWNER).from('tasks').select('id').eq('id', taskId)).data).toEqual([])
  })

  it('recovers from a worker that died mid-task: a new attempt continues from the checkpoint without repeating the action', async () => {
    let wake: (value: Partial<ModelTurnResult>) => void = () => {}
    const hang = () => new Promise<Partial<ModelTurnResult>>((resolve) => (wake = resolve))
    const { deps, requests, model } = await setup([search(), hang, finish(async () => (await executions(taskId)).map((row) => row.id))])
    const taskId = await assign('Is Dana in HubSpot?')

    // Worker 1 runs the search, then hangs in its next model call (the server "dies").
    const stale = processEmployeeTasks(deps, 1, taskId)
    await vi.waitFor(async () => expect(model.requests).toHaveLength(2), { timeout: 10_000 })
    expect(await executions(taskId)).toHaveLength(1)

    // Its lease runs out; the next dispatch recovers the task.
    await db.sql(`update public.tasks set lease_expires_at = now() - interval '1 second' where id = $1`, [taskId])
    const recovered = await dispatch(deps)
    expect(recovered.outcomes).toEqual(['succeeded'])
    const attempts = await attemptsOf(taskId)
    expect(attempts.map((row) => [row.attempt_number, row.status])).toEqual([[1, 'timed_out'], [2, 'succeeded']])
    expect((attempts[0]!.error as { code: string }).code).toBe('worker_lost')
    expect(requests).toHaveLength(1)
    expect(await executions(taskId)).toHaveLength(1)
    // The new attempt continued the conversation: its first call already had the search result.
    const resumedMessages = model.requests[2]!.messages
    expect(resumedMessages.at(-1)).toMatchObject({ role: 'tool_results', results: [expect.objectContaining({ toolCallId: 'call-search' })] })
    expect(await events(taskId)).toEqual(expect.arrayContaining(['task.attempt_lost', 'task.recovered', 'task.retrying', 'task.succeeded']))

    // The dead worker wakes up: it cannot write anything.
    const before = await taskRow(taskId)
    wake(search('call-late'))
    expect((await stale).results).toEqual([expect.objectContaining({ status: 'superseded' })])
    expect(await taskRow(taskId)).toMatchObject({ status: 'succeeded', updated_at: before.updated_at })
    expect(await executions(taskId)).toHaveLength(1)
  })

  it('waits for approval with nothing running, and resumes the same attempt after the decision', async () => {
    const { deps, requests } = await setup([upsert(), finish(async () => (await executions(taskId)).map((row) => row.id), 'Created the contact.')])
    const taskId = await assign('Add new@example.com to HubSpot')
    expect((await dispatch(deps)).outcomes).toEqual(['waiting_approval'])
    expect(await taskRow(taskId)).toMatchObject({ status: 'waiting_approval', lease_expires_at: null })
    expect((await dispatch(deps)).started).toBe(0)

    const [approval] = await db.sql<{ id: string; payload_sha256: string }>('select id, payload_sha256 from public.approval_requests where task_id = $1', [taskId])
    // External writes need an admin's approval.
    const decided = await db.as(OWNER).rpc('decide_approval', { p_request_id: approval!.id, p_decision: 'approved', p_payload_sha256: approval!.payload_sha256 })
    expect(decided.error).toBeNull()
    // The approved action runs first; its result re-queues the task (database trigger).
    await processApprovedExecutions(deps.integrations!, 5)
    // The upsert looks the contact up, then writes it: one write, made only after approval.
    expect(requests.filter((request) => request.method !== 'POST' || !request.url.endsWith('/search'))).toHaveLength(1)
    expect((await taskRow(taskId)).status).toBe('queued')

    expect((await dispatch(deps)).outcomes).toEqual(['succeeded'])
    expect(await attemptsOf(taskId)).toHaveLength(1)
    expect(await events(taskId)).toEqual(expect.arrayContaining(['task.waiting_approval', 'task.resumed', 'tool.approval_result', 'task.succeeded']))
  })

  it('cancels mid-step: no further steps, pending approvals withdrawn, completed actions stay recorded', async () => {
    let taskId = ''
    const { deps, requests, model } = await setup([
      search(),
      async () => {
        // While the employee is working, an operator cancels. The step in progress finishes.
        expect((await db.as(OPERATOR).rpc('cancel_employee_task', { p_task_id: taskId })).data).toBe('cancel_requested')
        return upsert()
      },
      finish(() => []),
    ])
    taskId = await assign('Search, then add a contact')
    expect((await dispatch(deps)).outcomes).toEqual(['cancelled'])

    expect(await taskRow(taskId)).toMatchObject({ status: 'cancelled', lease_expires_at: null })
    expect((await attemptsOf(taskId))[0]).toMatchObject({ status: 'cancelled' })
    const actions = await executions(taskId)
    // The search ran before the cancellation and stays done; the write requested in the
    // cancelled step was refused by the executor and never reached HubSpot.
    expect(actions.map((row) => [row.tool_key, row.status])).toEqual([['hubspot.contacts.search', 'succeeded']])
    expect(requests).toHaveLength(1)
    expect(model.requests).toHaveLength(2)
    expect((await dispatch(deps)).started).toBe(0)
    expect(await events(taskId)).toEqual(expect.arrayContaining(['task.cancel_requested', 'task.cancelled']))
  })

  it('cancelling a waiting task withdraws its approval and skips the tasks that depend on it', async () => {
    const { deps, requests } = await setup([upsert()])
    const first = await assign('Add a contact', { priority: 10 })
    const second = await assign('Tell sales about it', { dependsOn: [first] })
    expect((await taskRow(second)).status).toBe('pending')
    expect((await dispatch(deps)).outcomes).toEqual(['waiting_approval'])

    expect((await db.as(OPERATOR).rpc('cancel_employee_task', { p_task_id: first })).data).toBe('cancelled')
    const [approval] = await db.sql<{ id: string; status: string; payload_sha256: string }>('select * from public.approval_requests where task_id = $1', [first])
    expect(approval!.status).toBe('cancelled')
    // Approving it afterwards is impossible, so the action can never run.
    expect((await db.as(OWNER).rpc('decide_approval', { p_request_id: approval!.id, p_decision: 'approved', p_payload_sha256: approval!.payload_sha256 })).error).toMatchObject({ code: '55000' })
    await processApprovedExecutions(deps.integrations!, 5)
    expect(requests).toHaveLength(0)
    expect(await taskRow(second)).toMatchObject({ status: 'skipped', error: { code: 'dependency_not_met' } })
    expect((await dispatch(deps)).started).toBe(0)
  })

  it('pauses after the current step and resumes the same attempt from its checkpoint', async () => {
    let taskId = ''
    const { deps, requests } = await setup([
      async () => {
        expect((await db.as(OPERATOR).rpc('pause_employee_task', { p_task_id: taskId })).data).toBe('pause_requested')
        return search()
      },
      finish(async () => (await executions(taskId)).map((row) => row.id)),
    ])
    taskId = await assign('Is Dana in HubSpot?')
    expect((await dispatch(deps)).outcomes).toEqual(['paused'])
    expect(await taskRow(taskId)).toMatchObject({ status: 'paused', paused_from: 'queued', lease_expires_at: null })
    expect((await dispatch(deps)).started).toBe(0)

    expect((await db.as(VIEWER).rpc('resume_employee_task', { p_task_id: taskId })).error).toMatchObject({ code: 'P0002' })
    expect((await db.as(OPERATOR).rpc('resume_employee_task', { p_task_id: taskId })).data).toBe('queued')
    expect((await dispatch(deps)).outcomes).toEqual(['succeeded'])
    expect(await attemptsOf(taskId)).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect(await events(taskId)).toEqual(expect.arrayContaining(['task.pause_requested', 'task.paused', 'task.resumed', 'task.succeeded']))
  })

  it('times out a task that waits past its deadline, and withdraws what it was waiting for', async () => {
    const { deps } = await setup([upsert()])
    const taskId = await assign('Add a contact', { timeoutMinutes: 5 })
    expect((await dispatch(deps)).outcomes).toEqual(['waiting_approval'])
    await db.sql(`update public.tasks set created_at = now() - interval '1 hour', deadline_at = now() - interval '1 minute' where id = $1`, [taskId])

    const swept = await dispatch(deps)
    expect(swept.tasksTimedOut).toBe(1)
    expect(await taskRow(taskId)).toMatchObject({ status: 'failed', error: { code: 'deadline_passed', class: 'limit' } })
    expect((await executions(taskId))[0]!.status).toBe('cancelled')
    expect((await attemptsOf(taskId))[0]).toMatchObject({ status: 'timed_out' })
  })

  it('retries a failed task from its checkpoint with fresh limits, without repeating completed actions', async () => {
    const { deps, requests } = await setup([search(), search('call-again'), finish(async () => (await executions(taskId)).map((row) => row.id))], { maxTurnsPerTask: 1 })
    const taskId = await assign('Is Dana in HubSpot?')
    expect((await dispatch(deps)).outcomes).toEqual(['failed'])
    expect(await taskRow(taskId)).toMatchObject({ status: 'failed', error: { code: 'limit_reached', class: 'limit' } })
    expect(requests).toHaveLength(1)

    expect((await db.as(OPERATOR).rpc('retry_employee_task', { p_task_id: taskId })).data).toBe('queued')
    // Each retry round gets one more step (the limit), continuing where it stopped.
    expect((await dispatch(deps)).outcomes).toEqual(['failed'])
    expect((await db.as(OPERATOR).rpc('retry_employee_task', { p_task_id: taskId })).data).toBe('queued')
    expect((await dispatch(deps)).outcomes).toEqual(['succeeded'])
    // The first search ran once; the second search was a new call, also once.
    expect((await executions(taskId)).map((row) => row.idempotency_key)).toEqual([`task:${taskId}:call-search`, `task:${taskId}:call-again`])
    expect(requests).toHaveLength(2)
    expect(await events(taskId)).toEqual(expect.arrayContaining(['task.retry_requested', 'task.retrying']))
  })

  it('retries temporary model failures as new attempts, then fails once attempts are used up', async () => {
    const busy = () => new ModelError('overloaded', 'Busy.', true)
    const { deps } = await setup([busy(), busy(), busy(), busy(), busy(), busy(), busy(), busy(), busy()])
    const taskId = await assign('Is Dana in HubSpot?')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await dispatch(deps)
      // Skip the backoff.
      await db.sql(`update public.tasks set scheduled_at = null where id = $1`, [taskId])
    }
    expect(await taskRow(taskId)).toMatchObject({ status: 'failed', attempt_count: 3, error: { class: 'transient' } })
    expect((await attemptsOf(taskId)).map((row) => row.status)).toEqual(['failed', 'failed', 'failed'])
  })

  it('runs dependent tasks in order, highest priority first, once what they wait for succeeds', async () => {
    const order: string[] = []
    const { deps } = await setup([
      (request) => (order.push(String(request.messages[0] && 'text' in request.messages[0] ? request.messages[0].text : '')), finish(() => [], 'Checked.')()),
      (request) => (order.push(String(request.messages[0] && 'text' in request.messages[0] ? request.messages[0].text : '')), finish(() => [], 'Checked.')()),
      (request) => (order.push(String(request.messages[0] && 'text' in request.messages[0] ? request.messages[0].text : '')), finish(() => [], 'Checked.')()),
    ])
    const low = await assign('Low priority check', { priority: -10 })
    const high = await assign('High priority check', { priority: 50 })
    const after = await assign('After the high one', { priority: 100, dependsOn: [high] })
    const first = await dispatch(deps)
    expect(first.outcomes).toEqual(['succeeded', 'succeeded'])
    expect(order[0]).toContain('High priority check')
    expect(order[1]).toContain('Low priority check')
    expect((await taskRow(after)).status).toBe('queued')
    expect((await dispatch(deps)).outcomes).toEqual(['succeeded'])
    expect(await events(after)).toEqual(expect.arrayContaining(['task.pending', 'task.dependencies_met', 'task.succeeded']))
    expect((await taskRow(low)).status).toBe('succeeded')
  })
})

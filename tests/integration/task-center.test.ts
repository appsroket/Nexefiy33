// The Task Center's queries and actions against PostgreSQL, under each
// user's own row-level security: filters by status, employee, workflow, date
// and failure type; the detail view (objective, employee and version,
// workflow version, steps, actions, approvals, errors, result, cost and
// duration); and the cancel action's disclosure of what already happened.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseListParams } from '@/lib/list-params'
import type { ModelGateway, ModelTurnRequest, ModelTurnResult } from '@/modules/models/server/gateway'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import { TASK_LIST_SPEC } from '@/modules/tasks/domain/task-center'
import { processEmployeeTasks, type TaskRuntimeDeps } from '@/modules/tasks/server/runner'

import { jsonResponse } from '../helpers/integration-fixtures'
import type { PgSupabase } from '../helpers/pg-supabase'
import { createTestDatabase, EMPLOYEE, LOCAL_DB, OPERATOR, ORG, OTHER_OWNER, OWNER, SEARCH_URL, seedSalesEmployee, UPSERT_URL, VIEWER, type TestDatabase } from './database'

let db: TestDatabase
let client: PgSupabase

vi.mock('@/lib/supabase/server', () => ({ createUserClient: async () => client }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/modules/identity/server/session', () => ({
  SESSION_ENDED_MESSAGE: 'Your session ended.',
  getVerifiedUser: async () => ({ id: OPERATOR, email: null }),
}))
vi.mock('@/modules/tasks/server/scheduling', () => ({ canRunTasks: () => true, scheduleTaskProcessing: vi.fn() }))

const queries = await import('@/modules/tasks/server/queries')
const actions = await import('@/modules/tasks/server/actions')

const FIXTURE_WORKFLOW = 'a5000000-0000-4000-8000-000000000001'
const FIXTURE_WORKFLOW_TASK = 'a7000000-0000-4000-8000-000000000001'

function model(steps: ((request: ModelTurnRequest) => Promise<Partial<ModelTurnResult>> | Partial<ModelTurnResult>)[]): ModelGateway {
  return {
    provider: 'anthropic',
    turn: vi.fn(async (request: ModelTurnRequest) => {
      const step = steps.shift()
      if (!step) throw new Error('no more scripted steps')
      return { text: '', toolCalls: [], stopReason: 'end_turn' as const, model: 'claude-sonnet-5-5', usage: { inputTokens: 2000, outputTokens: 200 }, assistantContent: [], ...(await step(request)) }
    }),
    structured: vi.fn(),
  }
}

beforeEach(async () => {
  if (!LOCAL_DB) return
  db = await createTestDatabase()
  client = db.as(OPERATOR)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (LOCAL_DB) await db.close()
})

async function assign(title: string, priority = 0) {
  const { data, error } = await db.as(OPERATOR).rpc('assign_employee_task', {
    p_employee_id: EMPLOYEE,
    p_title: title,
    p_instructions: 'Check the CRM.',
    p_idempotency_key: `key-${Math.random().toString(36).slice(2, 12)}`,
    p_priority: priority,
  })
  expect(error).toBeNull()
  return data as string
}

const list = (params: Record<string, string> = {}) => parseListParams(params, TASK_LIST_SPEC)

describe.skipIf(!LOCAL_DB)('the Task Center on PostgreSQL', () => {
  it('filters by status, employee, workflow, date and failure type, under the user’s own access', async () => {
    await seedSalesEmployee(db, [])
    const done = await assign('Finished one')
    const failed = await assign('Ran out of steps')
    const queued = await assign('Still queued', 50)
    await db.sql(`update public.tasks set status = 'succeeded', started_at = now() - interval '2 minutes', completed_at = now() where id = $1`, [done])
    await db.sql(
      `update public.tasks set status = 'failed', started_at = now() - interval '1 minute', completed_at = now(),
         error = '{"code": "limit_reached", "class": "limit", "message": "Stopped after 10 steps."}' where id = $1`,
      [failed],
    )
    await db.sql(`update public.tasks set created_at = now() - interval '40 days' where id = $1`, [queued])

    const all = await queries.listTasks(ORG, list())
    // Three assigned tasks plus the fixture's workflow task.
    expect(all.total).toBe(4)
    expect((await queries.listTasks(ORG, list({ status: 'failed' }))).items.map((task) => task.id)).toEqual([failed])
    expect((await queries.listTasks(ORG, list({ failure: 'limit' }))).items).toEqual([expect.objectContaining({ id: failed, failure: { class: 'limit', code: 'limit_reached' } })])
    expect((await queries.listTasks(ORG, list({ failure: 'transient' }))).total).toBe(0)
    expect((await queries.listTasks(ORG, list(), { employeeId: EMPLOYEE })).total).toBe(3)
    expect((await queries.listTasks(ORG, list(), { workflowId: FIXTURE_WORKFLOW })).items).toEqual([
      expect.objectContaining({ id: FIXTURE_WORKFLOW_TASK, workflowName: 'Reply to email' }),
    ])
    expect((await queries.listTasks(ORG, list({ period: '30d' }))).items.map((task) => task.id)).not.toContain(queued)
    expect((await queries.listTasks(ORG, list({ q: 'queued' }))).items.map((task) => task.id)).toEqual([queued])
    expect((await queries.listTasks(ORG, list({ sort: 'priority', dir: 'desc' }))).items[0]!.id).toBe(queued)
    const finished = (await queries.listTasks(ORG, list({ status: 'succeeded' }))).items[0]!
    expect(finished.durationMs).toBeGreaterThanOrEqual(119_000)

    client = db.as(VIEWER)
    expect((await queries.listTasks(ORG, list())).total).toBe(4)
    client = db.as(OTHER_OWNER)
    expect((await queries.listTasks(ORG, list())).total).toBe(0)
    expect(await queries.getTask(ORG, failed)).toBeNull()
  })

  it('shows a task’s full history: objective, employee version, steps, actions, approvals, result, cost and duration', async () => {
    const seeded = await seedSalesEmployee(db, [[SEARCH_URL, () => jsonResponse(200, { total: 0, results: [] })], [UPSERT_URL, () => jsonResponse(201, { id: '901', properties: { email: 'new@example.com' } })]])
    const taskId = await assign('Add new@example.com to HubSpot')
    const executionIds = async () => (await db.sql<{ id: string }>('select id from public.tool_executions where task_id = $1', [taskId])).map((row) => row.id)
    const deps: TaskRuntimeDeps = {
      admin: db.admin as never,
      gateway: model([
        () => ({ toolCalls: [{ id: 'call-upsert', name: 'hubspot__contacts__upsert', input: { email: 'new@example.com', firstName: 'New' } }], stopReason: 'tool_use' }),
        async () => ({ toolCalls: [{ id: 'call-finish', name: 'finish_task', input: { status: 'completed', summary: 'Created the contact.', receipts: await executionIds() } }], stopReason: 'tool_use' }),
      ]),
      integrations: seeded.runtime,
      embedder: null,
      sleep: async () => {},
    }
    await processEmployeeTasks(deps, 1, taskId)
    const [approval] = await db.sql<{ id: string; payload_sha256: string }>('select id, payload_sha256 from public.approval_requests where task_id = $1', [taskId])
    expect((await db.as(OWNER).rpc('decide_approval', { p_request_id: approval!.id, p_decision: 'approved', p_payload_sha256: approval!.payload_sha256, p_note: 'Fine.' })).error).toBeNull()
    await processApprovedExecutions(seeded.runtime, 5)
    await processEmployeeTasks(deps, 1, taskId)

    const task = await queries.getTask(ORG, taskId)
    expect(task).toMatchObject({
      title: 'Add new@example.com to HubSpot',
      instructions: 'Check the CRM.',
      status: 'succeeded',
      // The name comes from the pinned configuration's profile.
      employeeName: 'Sales Operations Assistant',
      employeeVersion: 1,
      workflow: null,
      attemptCount: 1,
      result: { report: { status: 'completed', summary: 'Created the contact.' }, verification: { status: 'verified' } },
    })
    expect(task!.actions).toEqual([expect.objectContaining({ toolKey: 'hubspot.contacts.upsert', status: 'succeeded', decision: 'require_approval', approvalRequestId: approval!.id })])
    expect(task!.approvals).toEqual([expect.objectContaining({ id: approval!.id, status: 'approved', note: 'Fine.' })])
    expect(task!.events.map((event) => event.type)).toEqual(expect.arrayContaining(['task.queued', 'task.started', 'model.turn', 'tool.called', 'task.waiting_approval', 'tool.approval_result', 'task.succeeded']))
    expect(task!.costMicros).toBeGreaterThan(0)
    expect(task!.inputTokens).toBe(4000)
    expect(task!.durationMs).not.toBeNull()
    expect(task!.activeMs).toBeGreaterThanOrEqual(0)
    expect(task!.attempts).toEqual([expect.objectContaining({ number: 1, status: 'succeeded', turns: 2 })])

    // The fixture's workflow task shows its workflow and pinned version.
    expect(await queries.getTask(ORG, FIXTURE_WORKFLOW_TASK)).toMatchObject({ workflow: { name: 'Reply to email', version: 1, runStatus: 'running' } })
  })

  it('cancelling discloses the action that already happened and can’t be undone', async () => {
    const seeded = await seedSalesEmployee(db, [[SEARCH_URL, () => jsonResponse(200, { total: 0, results: [] })], [UPSERT_URL, () => jsonResponse(201, { id: '901', properties: { email: 'new@example.com' } })]])
    const taskId = await assign('Add a contact, then ask')
    const deps: TaskRuntimeDeps = {
      admin: db.admin as never,
      gateway: model([
        () => ({ toolCalls: [{ id: 'call-upsert', name: 'hubspot__contacts__upsert', input: { email: 'new@example.com', firstName: 'New' } }], stopReason: 'tool_use' }),
        () => ({ toolCalls: [{ id: 'call-ask', name: 'escalate', input: { reason: 'Need the company name', message: 'Which company is this contact at?' } }], stopReason: 'tool_use' }),
      ]),
      integrations: seeded.runtime,
      embedder: null,
      sleep: async () => {},
    }
    // The write is approved and carried out; then the employee escalates and waits for a reply.
    expect((await processEmployeeTasks(deps, 1, taskId)).results[0]).toMatchObject({ status: 'waiting_approval' })
    const [approval] = await db.sql<{ id: string; payload_sha256: string }>('select id, payload_sha256 from public.approval_requests where task_id = $1', [taskId])
    await db.as(OWNER).rpc('decide_approval', { p_request_id: approval!.id, p_decision: 'approved', p_payload_sha256: approval!.payload_sha256 })
    await processApprovedExecutions(seeded.runtime, 5)
    expect((await processEmployeeTasks(deps, 1, taskId)).results[0]).toMatchObject({ status: 'blocked' })

    const result = await actions.cancelTask(taskId)
    expect(result).toMatchObject({ status: 'success', message: expect.stringContaining('had already been carried out (hubspot.contacts.upsert) and can’t be undone') })
    expect(await queries.getTask(ORG, taskId)).toMatchObject({ status: 'cancelled', actions: [expect.objectContaining({ status: 'succeeded' })] })
    // Viewers can't cancel.
    client = db.as(VIEWER)
    expect(await actions.cancelTask(await assign('Another'))).toMatchObject({ status: 'error', message: expect.stringContaining('your role') })
  })
})

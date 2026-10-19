// Governance against a real PostgreSQL with every migration applied: the real
// runner, executor and SQL functions, a scripted model and a fake HubSpot (no
// live model or provider call). Every person's action is a direct call as
// that user (RLS and grants apply, as through PostgREST); nothing goes
// through the UI.
//
// Approval integrity: the employee can't approve (no tool, no privilege; the
//   service role it runs as is refused), a separate approver is enforced, and
//   an approval stops holding when what it was bound to changes.
// Auditability: each step leaves an audit entry naming who acted.
// Revocation: revoking a tool cancels what waits on it and later calls fail.
// Emergency stop: work stops after the current step, nothing new starts, and
//   lifting it resumes exactly what it paused.
// Also: data-access restrictions, workspace spending limits, human handoff.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import type { ModelGateway, ModelTurnRequest, ModelTurnResult } from '@/modules/models/server/gateway'
import { dispatchDueTasks } from '@/modules/tasks/server/dispatch'
import { processEmployeeTasks, type TaskRuntimeDeps } from '@/modules/tasks/server/runner'

import { jsonResponse } from '../helpers/integration-fixtures'
import { createTestDatabase, EMPLOYEE, HUBSPOT, LOCAL_DB, OPERATOR, ORG, OWNER, SEARCH_URL, seedSalesEmployee, UPSERT_URL, VIEWER, type TestDatabase } from './database'

const ADMIN = 'a0000000-0000-4000-8000-000000000002'
const FAQ_SOURCE = 'a3000000-0000-4000-8000-000000000001'

type Step = Partial<ModelTurnResult> | ((request: ModelTurnRequest) => Partial<ModelTurnResult> | Promise<Partial<ModelTurnResult>>)

function scriptedModel(steps: Step[]): ModelGateway & { requests: ModelTurnRequest[] } {
  const requests: ModelTurnRequest[] = []
  return {
    provider: 'anthropic',
    requests,
    turn: vi.fn(async (request: ModelTurnRequest) => {
      requests.push({ ...request, messages: [...request.messages] })
      const next = steps.shift()
      if (!next) throw new Error('no more scripted steps')
      const step = typeof next === 'function' ? await next(request) : next
      return { text: '', toolCalls: [], stopReason: 'end_turn' as const, model: 'claude-sonnet-5-5', usage: { inputTokens: 2000, outputTokens: 200 }, assistantContent: [], ...step }
    }),
    structured: vi.fn(),
  }
}

const call = (id: string, name: string, input: Record<string, unknown>) => ({ id, name, input })
const tools = (...calls: ReturnType<typeof call>[]) => ({ toolCalls: calls, stopReason: 'tool_use' as const })
const upsertCall = (id = 'call-upsert', email = 'new@example.com') => call(id, 'hubspot__contacts__upsert', { email, firstName: 'New' })
const finish = (summary = 'Done.', receipts: () => Promise<string[]> | string[] = () => []) => async () =>
  tools(call('call-finish', 'finish_task', { status: 'completed', summary, receipts: await receipts() }))

const searchOk = () => jsonResponse(200, { total: 0, results: [] })
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

async function setup(steps: Step[]) {
  const seeded = await seedSalesEmployee(db, [[SEARCH_URL, searchOk], [UPSERT_URL, upsertOk]])
  const model = scriptedModel(steps)
  const deps: TaskRuntimeDeps = { admin: db.admin as never, gateway: model, integrations: seeded.runtime, embedder: null, sleep: async () => {} }
  const writes = () => seeded.requests.filter((request) => request.method === 'POST' && !request.url.endsWith('/search'))
  return { ...seeded, model, deps, writes }
}

async function assign(title: string, by = OPERATOR) {
  const { data, error } = await db.as(by).rpc('assign_employee_task', {
    p_employee_id: EMPLOYEE,
    p_title: title,
    p_instructions: 'Keep the CRM current.',
    p_idempotency_key: `key-${Math.random().toString(36).slice(2, 12)}`,
  })
  expect(error).toBeNull()
  return data as string
}

const run = async (deps: TaskRuntimeDeps, taskId: string) => (await processEmployeeTasks(deps, 1, taskId)).results.map((result) => result.status)
const taskRow = async (id: string) => (await db.sql<Record<string, unknown>>('select * from public.tasks where id = $1', [id]))[0]!
const approvalFor = async (taskId: string) =>
  (await db.sql<{ id: string; payload_sha256: string; status: string; tool_execution_id: string; separate_approver: boolean; binding: Record<string, unknown>; risk_tier: string; required_role: string }>(
    'select * from public.approval_requests where task_id = $1 order by created_at desc limit 1',
    [taskId],
  ))[0]!
const executionRow = async (id: string) => (await db.sql<Record<string, unknown>>('select * from public.tool_executions where id = $1', [id]))[0]!
const decide = (user: string, approval: { id: string; payload_sha256: string }, decision = 'approved') =>
  db.as(user).rpc('decide_approval', { p_request_id: approval.id, p_decision: decision, p_payload_sha256: approval.payload_sha256 })
const auditActions = async () => (await db.sql<{ action: string }>('select action from public.audit_logs where organization_id = $1 order by id', [ORG])).map((row) => row.action)

async function addPolicy(by: string, name: string, policy: Record<string, unknown>) {
  const { error } = await db.as(by).from('organization_policies').insert({ organization_id: ORG, name, policy_schema_version: 2, policy: policy as never })
  expect(error).toBeNull()
}

/** A new active version of the employee whose own rule for the CRM write is "allow" (grants follow it). */
async function allowWritesInEmployeeVersion() {
  const [current] = await db.sql<{ config: { tools: { toolKey: string; approval: string }[] }; instructions: string }>(
    'select v.config, v.instructions from public.employee_versions as v join public.ai_employees as e on e.active_version_id = v.id where e.id = $1',
    [EMPLOYEE],
  )
  const config = { ...current!.config, tools: current!.config.tools.map((tool) => (tool.toolKey === 'hubspot.contacts.upsert' ? { ...tool, approval: 'allow' } : tool)) }
  const [version] = await db.sql<{ id: string }>(
    `insert into public.employee_versions (organization_id, employee_id, instructions, config, config_schema_version) values ($1, $2, $3, $4, 2) returning id`,
    [ORG, EMPLOYEE, current!.instructions, JSON.stringify(config)],
  )
  await db.sql('update public.ai_employees set current_version_id = $1, active_version_id = $1 where id = $2', [version!.id, EMPLOYEE])
  await db.sql(`update public.employee_tool_permissions set decision = 'allow' where employee_id = $1 and tool_key = 'hubspot.contacts.upsert'`, [EMPLOYEE])
}

describe.skipIf(!LOCAL_DB)('governance on PostgreSQL', () => {
  it('approval integrity: the employee cannot approve its own action, a separate approver is enforced, and the decision is audited', async () => {
    let taskId = ''
    const { deps, writes } = await setup([
      // The model proposes the write and, in the same turn, tries to approve it itself.
      tools(upsertCall(), call('call-approve', 'approvals__decide', { decision: 'approved' })),
      finish('Created the contact.', async () => [(await approvalFor(taskId)).tool_execution_id]),
    ])
    await addPolicy(OWNER, 'Four eyes', { rules: [], approvals: { separateApprover: true } })
    // The owner assigns the task, so the owner is the requester of the employee's action.
    taskId = await assign('Add new@example.com to HubSpot', OWNER)
    expect(await run(deps, taskId)).toEqual(['waiting_approval'])

    const approval = await approvalFor(taskId)
    expect(approval).toMatchObject({ status: 'pending', separate_approver: true, risk_tier: 'medium', required_role: 'admin', binding: { connectionAccountId: '123456' } })
    const toolEvents = await db.sql<{ data: { tool_key: string; decision: string } }>(`select data from public.execution_events where task_id = $1 and event_type = 'tool.called'`, [taskId])
    // "approvals__decide" isn't a tool: nothing an employee can call decides approvals.
    expect(toolEvents.map((row) => row.data.tool_key)).toEqual(expect.arrayContaining(['hubspot.contacts.upsert', 'approvals.decide']))
    expect(toolEvents.find((row) => row.data.tool_key === 'approvals.decide')!.data.decision).toBe('refused')

    // The service role the employee runs as is refused by the database.
    const forged = await db.admin.from('approval_requests').update({ status: 'approved', decided_at: new Date().toISOString() }).eq('id', approval.id).select('id')
    expect(forged.error?.code).toBe('42501')
    // The requester can't approve their own request; a viewer can't approve at all.
    expect((await decide(OWNER, approval)).error).toMatchObject({ code: '42501', message: expect.stringContaining('someone else must approve') })
    expect((await decide(VIEWER, approval)).error?.code).toBe('P0002')
    expect((await approvalFor(taskId)).status).toBe('pending')
    expect(writes()).toHaveLength(0)

    // Another admin approves; only then does the write happen.
    expect((await decide(ADMIN, approval)).error).toBeNull()
    const [executed] = (await processApprovedExecutions(deps.integrations!, 5)).results
    expect(executed).toMatchObject({ status: 'succeeded' })
    expect(writes()).toHaveLength(1)
    expect(await run(deps, taskId)).toEqual(['succeeded'])

    const audit = await db.sql<{ action: string; actor_type: string; actor_user_id: string | null; actor_employee_id: string | null; metadata: Record<string, unknown> }>(
      `select action, actor_type, actor_user_id, actor_employee_id, metadata from public.audit_logs where organization_id = $1 order by id`,
      [ORG],
    )
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'organization_policies.insert', actor_user_id: OWNER }),
        expect.objectContaining({ action: 'action.approval_requested', actor_type: 'employee', actor_employee_id: EMPLOYEE, metadata: expect.objectContaining({ tier: 'medium', category: 'record_change' }) }),
        expect.objectContaining({ action: 'approval_requests.update', actor_type: 'user', actor_user_id: ADMIN, metadata: expect.objectContaining({ status: { from: 'pending', to: 'approved' } }) }),
        expect.objectContaining({ action: 'action.succeeded', actor_type: 'employee', actor_employee_id: EMPLOYEE }),
      ]),
    )
    // Admins read the trail through the API; viewers and operators don't.
    expect((await db.as(ADMIN).from('audit_logs').select('action').eq('action', 'action.succeeded')).data).toHaveLength(1)
    expect((await db.as(VIEWER).from('audit_logs').select('action')).data).toEqual([])
    expect((await db.as(OPERATOR).from('audit_logs').select('action')).data).toEqual([])
  })

  it('an approval stops holding when the account, the approver’s role or the policy changes', async () => {
    const { deps, writes } = await setup([
      tools(upsertCall('call-1', 'one@example.com')),
      tools(upsertCall('call-2', 'two@example.com')),
      tools(upsertCall('call-3', 'three@example.com')),
    ])

    // 1. The connection is reconnected to a different HubSpot account after approval.
    const first = await assign('Add one@example.com')
    expect(await run(deps, first)).toEqual(['waiting_approval'])
    expect((await decide(ADMIN, await approvalFor(first))).error).toBeNull()
    await db.sql(`update public.integrations set external_account_id = '999999' where id = $1`, [HUBSPOT])
    expect((await processApprovedExecutions(deps.integrations!, 5)).results[0]).toMatchObject({ status: 'failed', error: { code: 'approval_invalidated', message: expect.stringContaining('different account') } })
    await db.sql(`update public.integrations set external_account_id = '123456' where id = $1`, [HUBSPOT])

    // 2. The admin who approved is demoted before the action runs.
    const second = await assign('Add two@example.com')
    expect(await run(deps, second)).toEqual(['waiting_approval'])
    expect((await decide(ADMIN, await approvalFor(second))).error).toBeNull()
    await db.sql(`update public.organization_members set role = 'operator' where organization_id = $1 and user_id = $2`, [ORG, ADMIN])
    expect((await processApprovedExecutions(deps.integrations!, 5)).results[0]).toMatchObject({ status: 'failed', error: { code: 'approval_invalidated', message: expect.stringContaining('no longer') } })
    await db.sql(`update public.organization_members set role = 'admin' where organization_id = $1 and user_id = $2`, [ORG, ADMIN])

    // 3. A policy blocking the action is added after approval.
    const third = await assign('Add three@example.com')
    expect(await run(deps, third)).toEqual(['waiting_approval'])
    expect((await decide(ADMIN, await approvalFor(third))).error).toBeNull()
    await addPolicy(OWNER, 'Freeze CRM', { rules: [{ effect: 'deny', categories: ['record_change'] }] })
    expect((await processApprovedExecutions(deps.integrations!, 5)).results[0]).toMatchObject({ status: 'failed', error: { code: 'denied_by_policy' } })

    expect(writes()).toHaveLength(0)
    expect((await auditActions()).filter((action) => action === 'approval.invalidated')).toHaveLength(2)
  })

  it('an explicit policy from an admin lets the employee act without approval; the same rule from no one does not', async () => {
    let taskId = ''
    const receipts = async () => (await db.sql<{ id: string }>('select id from public.tool_executions where task_id = $1', [taskId])).map((row) => row.id)
    const { deps, writes } = await setup([tools(upsertCall('call-a'))])
    // The fixture's "Default" policy requires approval for every external write; a restriction always beats an allow.
    expect((await db.as(OWNER).from('organization_policies').update({ enabled: false }).eq('name', 'Default').select('id')).data).toHaveLength(1)
    // Written by the service role: it authorizes nothing.
    await db.admin.from('organization_policies').insert({ organization_id: ORG, name: 'Unsigned', policy_schema_version: 2, policy: { rules: [{ effect: 'allow', toolKeys: ['hubspot.contacts.upsert'] }] } })
    const unsigned = await assign('Add a contact (unsigned policy)')
    expect(await run(deps, unsigned)).toEqual(['waiting_approval'])
    await db.sql(`delete from public.organization_policies where name = 'Unsigned'`)

    // The employee's own rule must not add approval either: activate a version that allows the write.
    await allowWritesInEmployeeVersion()
    await addPolicy(ADMIN, 'CRM upkeep', { rules: [{ effect: 'allow', toolKeys: ['hubspot.contacts.upsert'], actors: ['employee'] }] })
    const [policy] = await db.sql<{ authorized_role: string; revision: number }>(`select authorized_role, revision from public.organization_policies where name = 'CRM upkeep'`)
    expect(policy).toMatchObject({ authorized_role: 'admin', revision: 1 })
    const versions = await db.sql(`select change, authorized_role from public.organization_policy_versions where name = 'CRM upkeep'`)
    expect(versions).toEqual([{ change: 'created', authorized_role: 'admin' }])

    // Replace the scripted steps for the second task.
    deps.gateway = scriptedModel([tools(upsertCall('call-b', 'b@example.com')), finish('Created.', receipts)])
    taskId = await assign('Add b@example.com')
    expect(await run(deps, taskId)).toEqual(['succeeded'])
    expect(writes()).toHaveLength(1)
    expect((await db.sql<{ policy_decision: string; risk_tier: string }>('select policy_decision, risk_tier from public.tool_executions where task_id = $1', [taskId]))[0]).toMatchObject({
      policy_decision: 'allow',
      risk_tier: 'medium',
    })
  })

  it('revoking a tool cancels the action waiting on it, and the employee can no longer use it', async () => {
    const { deps, writes } = await setup([
      tools(upsertCall('call-1')),
      // After the revocation the task resumes and the employee tries again.
      tools(upsertCall('call-2')),
      finish('Could not create the contact.'),
    ])
    const taskId = await assign('Add new@example.com')
    expect(await run(deps, taskId)).toEqual(['waiting_approval'])
    const approval = await approvalFor(taskId)

    expect((await db.as(OPERATOR).rpc('revoke_employee_tool', { p_employee_id: EMPLOYEE, p_tool_key: 'hubspot.contacts.upsert', p_integration_id: HUBSPOT })).error?.code).toBe('P0002')
    const revoked = await db.as(ADMIN).rpc('revoke_employee_tool', { p_employee_id: EMPLOYEE, p_tool_key: 'hubspot.contacts.upsert', p_integration_id: HUBSPOT })
    expect(revoked).toMatchObject({ error: null, data: 1 })

    expect((await approvalFor(taskId)).status).toBe('cancelled')
    expect(await executionRow(approval.tool_execution_id)).toMatchObject({ status: 'cancelled', error: expect.objectContaining({ code: 'permission_revoked' }) })
    // Nothing waits any more, so the task went back to the queue; the next call is refused.
    expect((await taskRow(taskId)).status).toBe('queued')
    expect(await run(deps, taskId)).toEqual(['succeeded'])
    const refusals = await db.sql<{ message: string }>(`select message from public.execution_events where task_id = $1 and event_type = 'tool.called' order by id`, [taskId])
    expect(refusals.at(-1)!.message).toContain('not run')
    expect(writes()).toHaveLength(0)
    expect(await auditActions()).toEqual(expect.arrayContaining(['employee.tool_revoked', 'employee.tool_actions_cancelled']))
  })

  it('emergency stop: the running task stops after its step, nothing new starts or runs, and lifting resumes what it paused', async () => {
    let taskId = ''
    const { deps, writes } = await setup([
      async () => {
        // An admin hits the emergency stop while the employee is thinking.
        const stop = await db.as(ADMIN).rpc('set_emergency_stop', { p_organization_id: ORG, p_reason: 'Wrong contacts are being created' })
        expect(stop.error).toBeNull()
        return tools(upsertCall())
      },
      finish('Stopped work resumed and finished.'),
    ])
    taskId = await assign('Add new@example.com')
    expect(await run(deps, taskId)).toEqual(['paused'])

    const task = await taskRow(taskId)
    expect(task).toMatchObject({ status: 'paused' })
    expect(task.emergency_paused_at).not.toBeNull()
    // The action proposed in that step was refused before it was recorded or sent.
    expect(await db.sql('select id from public.tool_executions where task_id = $1', [taskId])).toEqual([])
    const called = await db.sql<{ message: string }>(`select message from public.execution_events where task_id = $1 and event_type = 'tool.called'`, [taskId])
    expect(called[0]!.message).toContain('not run')
    expect(writes()).toHaveLength(0)

    // While stopped: no new work, no resuming, no dispatch, no AI action.
    expect((await db.as(OPERATOR).rpc('assign_employee_task', { p_employee_id: EMPLOYEE, p_title: 'More work', p_instructions: null, p_idempotency_key: 'stop-key-0001' })).error?.code).toBe('55000')
    expect((await db.as(OPERATOR).rpc('resume_employee_task', { p_task_id: taskId })).error?.code).toBe('55000')
    expect((await dispatchDueTasks({ admin: deps.admin, integrations: deps.integrations, start: async () => {} })).started).toBe(0)
    expect((await db.as(OPERATOR).rpc('lift_emergency_stop', { p_organization_id: ORG, p_resume_tasks: true })).error?.code).toBe('P0002')

    const lifted = await db.as(OWNER).rpc('lift_emergency_stop', { p_organization_id: ORG, p_resume_tasks: true })
    expect(lifted).toMatchObject({ error: null, data: { resumed_tasks: 1 } })
    expect((await taskRow(taskId)).status).toBe('queued')
    expect(await run(deps, taskId)).toEqual(['succeeded'])

    const audit = await db.sql<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>(
      `select action, actor_user_id, metadata from public.audit_logs where action like 'governance.emergency%' order by id`,
    )
    expect(audit).toEqual([
      expect.objectContaining({ action: 'governance.emergency_stop', actor_user_id: ADMIN, metadata: expect.objectContaining({ reason: 'Wrong contacts are being created', stopping_tasks: 1 }) }),
      expect.objectContaining({ action: 'governance.emergency_stop_lifted', actor_user_id: OWNER, metadata: { resumed_tasks: 1 } }),
    ])
  })

  it('an employee emergency stop pauses it and withdraws its waiting action', async () => {
    const { deps, writes } = await setup([tools(upsertCall())])
    const taskId = await assign('Add new@example.com')
    expect(await run(deps, taskId)).toEqual(['waiting_approval'])
    const approval = await approvalFor(taskId)
    const stopped = await db.as(OPERATOR).rpc('emergency_stop_employee', { p_employee_id: EMPLOYEE, p_reason: 'It keeps adding contacts' })
    expect(stopped).toMatchObject({ error: null, data: { paused_tasks: 1, withdrawn_actions: 1 } })
    expect((await db.sql<{ status: string }>('select status from public.ai_employees where id = $1', [EMPLOYEE]))[0]!.status).toBe('paused')
    expect((await approvalFor(taskId)).status).toBe('cancelled')
    // Approving the withdrawn request is impossible, and nothing runs.
    expect((await decide(ADMIN, approval)).error?.code).toBe('55000')
    expect((await processApprovedExecutions(deps.integrations!, 5)).claimed).toBe(0)
    expect(writes()).toHaveLength(0)
  })

  it('data access: a blocked knowledge source never reaches the employee', async () => {
    const searchKnowledge = tools(call('call-k', 'knowledge__search', { query: 'refunds accepted' }))
    const { deps, model } = await setup([searchKnowledge, finish('Answered.')])
    await addPolicy(ADMIN, 'Keep the FAQ private', { rules: [], dataAccess: { blockedSourceIds: [FAQ_SOURCE] } })
    const taskId = await assign('What is the refund policy?')
    expect(await run(deps, taskId)).toEqual(['succeeded'])
    const transcript = JSON.stringify(model.requests.map((request) => request.messages))
    expect(transcript).not.toContain('Refunds are accepted within 30 days')
    expect(await db.sql('select id from public.task_evidence where task_id = $1 and knowledge_source_id = $2', [taskId, FAQ_SOURCE])).toEqual([])

    // Control: without the policy the same search finds the passage.
    await db.sql(`delete from public.organization_policies where name = 'Keep the FAQ private'`)
    deps.gateway = scriptedModel([searchKnowledge, finish('Answered.')])
    const control = await assign('What is the refund policy, again?')
    expect(await run(deps, control)).toEqual(['succeeded'])
    expect((await db.sql('select id from public.task_evidence where task_id = $1 and knowledge_source_id = $2', [control, FAQ_SOURCE])).length).toBeGreaterThan(0)
  })

  it('spending: a workspace monthly limit stops tasks once it is used up', async () => {
    const { deps, model } = await setup([finish()])
    await db.sql(
      `insert into public.usage_records (organization_id, metric, quantity, cost_micros, currency, idempotency_key) values ($1, 'model_cost', 1, 3000000, 'USD', 'gov-spend-1')`,
      [ORG],
    )
    await addPolicy(OWNER, 'AI budget', { rules: [], limits: { organizationMonthlyUsd: 2 } })
    const taskId = await assign('Anything')
    expect(await run(deps, taskId)).toEqual(['failed'])
    expect(await taskRow(taskId)).toMatchObject({ status: 'failed', error: expect.objectContaining({ code: 'workspace_budget_exhausted', class: 'limit' }) })
    expect(model.requests).toHaveLength(0)
  })

  it('human handoff: an escalated task is taken over by a person and never returns to the employee', async () => {
    const { deps } = await setup([tools(call('call-esc', 'escalate', { reason: 'needs a phone call', message: 'Please call the customer.' }))])
    const taskId = await assign('Sort out the billing complaint')
    expect(await run(deps, taskId)).toEqual(['blocked'])
    expect((await taskRow(taskId)).handoff_requested_at).not.toBeNull()

    expect((await db.as(VIEWER).rpc('hand_off_employee_task', { p_task_id: taskId })).error?.code).toBe('P0002')
    expect((await db.as(OPERATOR).rpc('hand_off_employee_task', { p_task_id: taskId, p_note: 'Calling them now.' })).error).toBeNull()
    expect(await taskRow(taskId)).toMatchObject({ status: 'blocked', handed_off_to: OPERATOR, handed_off_by: OPERATOR })
    expect((await db.as(OPERATOR).rpc('reply_to_employee_task', { p_task_id: taskId, p_message: 'Never mind, you do it.' })).error?.code).toBe('55000')
    expect((await dispatchDueTasks({ admin: deps.admin, integrations: deps.integrations, start: async () => {} })).started).toBe(0)

    expect((await db.as(OPERATOR).rpc('complete_handed_off_task', { p_task_id: taskId, p_outcome: 'done', p_note: 'Refunded by phone.' })).error).toBeNull()
    expect(await taskRow(taskId)).toMatchObject({ status: 'succeeded', result: expect.objectContaining({ handoff: expect.objectContaining({ completedBy: OPERATOR, outcome: 'done' }) }) })
    expect(await auditActions()).toEqual(expect.arrayContaining(['task.handed_off', 'task.completed_by_person']))
  })
})

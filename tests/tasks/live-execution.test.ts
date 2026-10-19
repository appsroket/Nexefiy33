// An employee acting through the integration executor (in-memory database,
// fake provider — a contract test, not a live HubSpot call): the employee
// acts only while active, on its own running task, with the grant written at
// activation; its approval rule can only add approval; its executions belong
// to its task (which the executor never finishes); repeated calls never run
// twice; and the live invoker reports only what the executor recorded.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createLiveToolInvoker } from '@/modules/employees/server/live-invoker'
import { resolveTool } from '@/modules/employees/server/tools'
import { processApprovedExecutions, requestAction, type EmployeeActor, type ExecuteRequest } from '@/modules/integrations/server/executor'

import { FakeSupabase } from '../helpers/fake-supabase'
import { allowRateLimits, HUBSPOT_ID, HUBSPOT_SCOPES, jsonResponse, ORG, recordingFetch, seedConnection, testRuntime, USER, type Responder } from '../helpers/integration-fixtures'

const EMPLOYEE = 'e1000000-0000-4000-8000-000000000001'
const VERSION = 'e2000000-0000-4000-8000-000000000001'
const TASK = 'e7000000-0000-4000-8000-000000000001'
const ATTEMPT = 'e8000000-0000-4000-8000-000000000001'
const SEARCH_URL = 'https://api.hubapi.com/crm/objects/2026-09/contacts/search'
const UPSERT_URL = 'https://api.hubapi.com/crm/objects/2026-09/contacts'

const searchOk: Responder = () => jsonResponse(200, { total: 1, results: [{ id: '501', properties: { email: 'dana@example.com', firstname: 'Dana' } }] })

let db: FakeSupabase

const actor: EmployeeActor = { kind: 'employee', employeeId: EMPLOYEE, employeeVersionId: VERSION, taskId: TASK, attemptId: ATTEMPT, requestedBy: USER }

beforeEach(() => {
  db = new FakeSupabase()
  db.uniqueKeys.tasks = [['organization_id', 'idempotency_key']]
  db.uniqueKeys.tool_executions = [['organization_id', 'idempotency_key']]
  allowRateLimits(db)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  db.tables.ai_employees = [{ id: EMPLOYEE, organization_id: ORG, status: 'active', name: 'Sales Ops' }]
  db.tables.tasks = [{ id: TASK, organization_id: ORG, employee_id: EMPLOYEE, status: 'running', title: 'Find Dana' }]
  db.tables.employee_tool_permissions = [
    { organization_id: ORG, employee_id: EMPLOYEE, tool_key: 'hubspot.contacts.search', integration_id: HUBSPOT_ID, decision: 'allow' },
    { organization_id: ORG, employee_id: EMPLOYEE, tool_key: 'hubspot.contacts.upsert', integration_id: HUBSPOT_ID, decision: 'require_approval' },
  ]
})

function setup(routes: [string, Responder | Responder[]][] = []) {
  const recorder = recordingFetch(routes)
  const { runtime } = testRuntime(db, recorder.fetch)
  return { runtime, requests: recorder.requests }
}

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    organizationId: ORG,
    integrationId: HUBSPOT_ID,
    actionKey: 'hubspot.contacts.search',
    input: { email: 'dana@example.com' },
    idempotencyKey: `task:${TASK}:call-1`,
    actor,
    ...overrides,
  }
}

describe('the executor with an employee as the actor', () => {
  it('runs a granted read on the employee’s own task and leaves the task to the runtime', async () => {
    const { runtime, requests } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    const result = await requestAction(runtime, request())
    expect(result).toMatchObject({ status: 'succeeded', output: { total: 1 } })
    expect(requests).toHaveLength(1)
    expect(db.tables.tasks).toHaveLength(1)
    expect(db.tables.tasks![0]).toMatchObject({ id: TASK, status: 'running' })
    expect(db.tables.tool_executions![0]).toMatchObject({ task_id: TASK, task_attempt_id: ATTEMPT, employee_id: EMPLOYEE, requested_by: USER, status: 'succeeded' })
    for (const query of db.queries.filter((query) => query.operation !== 'insert' && query.operation !== 'upsert')) {
      expect(query.filters, `${query.table} ${query.operation}`).toContainEqual(['organization_id', 'eq', ORG])
    }
  })

  it('refuses when the employee isn’t active, the task isn’t its running task, or the tool wasn’t granted', async () => {
    const { runtime, requests } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })

    db.tables.ai_employees![0]!.status = 'paused'
    expect(await requestAction(runtime, request())).toMatchObject({ status: 'refused', error: { code: 'forbidden', message: expect.stringContaining('isn’t active') } })
    db.tables.ai_employees![0]!.status = 'active'

    db.tables.tasks![0]!.status = 'waiting_approval'
    expect(await requestAction(runtime, request())).toMatchObject({ status: 'refused', error: { code: 'forbidden' } })
    db.tables.tasks![0]!.status = 'running'

    db.tables.employee_tool_permissions = db.tables.employee_tool_permissions!.filter((row) => row.tool_key !== 'hubspot.contacts.search')
    expect(await requestAction(runtime, request())).toMatchObject({ status: 'refused', error: { code: 'forbidden', message: expect.stringContaining('wasn’t granted') } })
    expect(requests).toHaveLength(0)
    expect(db.tables.tool_executions).toBeUndefined()
  })

  it('applies the grant and the approval floor: they add approval, never remove it', async () => {
    const { runtime, requests } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    const waiting = await requestAction(runtime, request({ approvalFloor: 'require_approval' }))
    expect(waiting).toMatchObject({ status: 'awaiting_approval' })
    expect(db.tables.approval_requests![0]).toMatchObject({ task_id: TASK, employee_id: EMPLOYEE, employee_version_id: VERSION })
    expect(requests).toHaveLength(0)

    // A write the grant says needs approval waits, even with an "allow" floor.
    const write = await requestAction(runtime, request({ actionKey: 'hubspot.contacts.upsert', input: { email: 'dana@example.com', firstName: 'Dana' }, idempotencyKey: `task:${TASK}:call-2`, approvalFloor: 'allow' }))
    expect(write).toMatchObject({ status: 'awaiting_approval' })
  })

  it('returns the first result when the same call is repeated (a resumed step)', async () => {
    const { runtime, requests } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    await requestAction(runtime, request())
    const repeated = await requestAction(runtime, request())
    expect(repeated).toMatchObject({ status: 'duplicate', executionStatus: 'succeeded' })
    expect(requests).toHaveLength(1)
  })

  it('runs an approved action without finishing the employee’s task, and re-checks the grant first', async () => {
    const { runtime, requests } = setup([[UPSERT_URL, () => jsonResponse(201, { id: '777', properties: { email: 'dana@example.com' } })]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    const waiting = await requestAction(runtime, request({ actionKey: 'hubspot.contacts.upsert', input: { email: 'dana@example.com', firstName: 'Dana' }, idempotencyKey: `task:${TASK}:call-3` }))
    expect(waiting.status).toBe('awaiting_approval')
    const execution = db.tables.tool_executions![0]!
    // Approved by an admin (what decide_approval records).
    Object.assign(db.tables.approval_requests![0]!, { status: 'approved', decided_by: 'a0000000-0000-4000-8000-0000000000ad', decided_at: '2026-10-18T12:01:00Z' })
    ;(db.tables.organization_members ??= []).push({ organization_id: ORG, user_id: 'a0000000-0000-4000-8000-0000000000ad', role: 'admin', status: 'active' })
    db.tables.tasks![0]!.status = 'waiting_approval'

    // The employee was paused in the meantime: the approved action doesn't run.
    db.tables.ai_employees![0]!.status = 'paused'
    db.rpcHandlers.claim_tool_executions = () => {
      execution.status = 'executing'
      return { data: [{ tool_execution_id: execution.id, organization_id: ORG, attempt: 1, recovered: false }], error: null }
    }
    const blocked = await processApprovedExecutions(runtime, 5)
    expect(blocked.results[0]).toMatchObject({ status: 'failed', error: { code: 'forbidden' } })
    expect(requests).toHaveLength(0)
    expect(db.tables.tasks![0]!.status).toBe('waiting_approval')
  })
})

describe('the live invoker', () => {
  function invoker(runtime: ReturnType<typeof setup>['runtime'] | null) {
    return createLiveToolInvoker({
      organizationId: ORG,
      actor,
      knowledge: { access: 'none', sourceIds: [], maxPassages: 5 },
      admin: db as never,
      embedder: null,
      integrations: runtime,
    })
  }
  const grant = (toolKey: string, approval: 'allow' | 'require_approval' = 'allow') => ({ toolKey, integrationId: HUBSPOT_ID, approval })

  it('returns a receipt and untrusted provider data only for an action the executor recorded as succeeded', async () => {
    const { runtime } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    const outcome = await invoker(runtime).invoke({ grant: grant('hubspot.contacts.search'), tool: resolveTool('hubspot.contacts.search')!, input: { email: 'dana@example.com' }, callId: 'c1' })
    const executionId = db.tables.tool_executions![0]!.id as string
    expect(outcome).toMatchObject({ decision: 'allow', executed: true, untrusted: true, executionId, content: expect.stringContaining(`Receipt: ${executionId}`) })
    expect(outcome.evidence).toEqual([expect.objectContaining({ kind: 'tool_result', executionId })])
    expect(db.tables.tool_executions![0]!.idempotency_key).toBe(`task:${TASK}:c1`)
  })

  it('validates input, and makes writes wait once suspicious content was read', async () => {
    const { runtime, requests } = setup()
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    db.tables.employee_tool_permissions![1]!.decision = 'allow'
    ;(db.tables.integration_actions ??= []).push({ organization_id: ORG, integration_id: HUBSPOT_ID, action_key: 'hubspot.contacts.upsert', enabled: true, approval_mode: 'allow' })
    const live = invoker(runtime)
    expect(await live.invoke({ grant: grant('hubspot.contacts.upsert'), tool: resolveTool('hubspot.contacts.upsert')!, input: { email: 'not-an-email' }, callId: 'c2' })).toMatchObject({ decision: 'refused', isError: true })

    const outcome = await live.invoke({
      grant: grant('hubspot.contacts.upsert'),
      tool: resolveTool('hubspot.contacts.upsert')!,
      input: { email: 'dana@example.com', firstName: 'Dana' },
      callId: 'c3',
      context: { suspiciousContentSeen: true },
    })
    expect(outcome).toMatchObject({ decision: 'require_approval', waiting: true, executed: false })
    expect(requests).toHaveLength(0)
  })

  it('resolves a waiting action from its stored status, never from the model', async () => {
    db.tables.tool_executions = [{ id: 'ex-1', organization_id: ORG, task_id: TASK, status: 'awaiting_approval', output_redacted: null, error: null }]
    const live = invoker(null)
    expect(await live.resolve!({ executionId: 'ex-1', toolKey: 'hubspot.contacts.upsert', callId: 'c' })).toBeNull()
    db.tables.tool_executions[0]!.status = 'rejected'
    expect(await live.resolve!({ executionId: 'ex-1', toolKey: 'hubspot.contacts.upsert', callId: 'c' })).toMatchObject({ executed: false, content: expect.stringContaining('rejected') })
    db.tables.tool_executions[0]!.status = 'succeeded'
    db.tables.tool_executions[0]!.output_redacted = { id: '777' }
    expect(await live.resolve!({ executionId: 'ex-1', toolKey: 'hubspot.contacts.upsert', callId: 'c' })).toMatchObject({ executed: true, content: expect.stringContaining('Receipt: ex-1') })
    db.tables.tool_executions[0]!.status = 'failed'
    db.tables.tool_executions[0]!.error = { code: 'outcome_unknown', message: 'No answer.' }
    expect(await live.resolve!({ executionId: 'ex-1', toolKey: 'hubspot.contacts.upsert', callId: 'c' })).toMatchObject({ isError: true, content: expect.stringContaining('unknown whether') })
  })
})

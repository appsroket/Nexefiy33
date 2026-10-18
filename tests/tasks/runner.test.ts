// The task runner end to end, in memory: a claimed task runs the shared
// runtime with a scripted model and the live invoker, which requests a
// HubSpot action through the real executor against a fake HubSpot (contract
// test — no live model or HubSpot call). It checks what the platform
// records: checkpoints, the trace, evidence, usage, verification against the
// executor's own records, waiting for approval and resuming, bounded retries,
// stopping when the employee is paused — and that every query is scoped to
// the task's organization.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildTemplateDraft, EMPLOYEE_TEMPLATES } from '@/modules/employees/domain/templates'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { ModelError, type ModelGateway, type ModelTurnRequest, type ModelTurnResult } from '@/modules/models/server/gateway'
import { processEmployeeTasks, type TaskRuntimeDeps } from '@/modules/tasks/server/runner'

import { FakeSupabase } from '../helpers/fake-supabase'
import { allowRateLimits, HUBSPOT_ID, HUBSPOT_SCOPES, jsonResponse, ORG, recordingFetch, seedConnection, SLACK_ID, testRuntime, USER } from '../helpers/integration-fixtures'

const EMPLOYEE = 'e1000000-0000-4000-8000-000000000001'
const VERSION = 'e2000000-0000-4000-8000-000000000001'
const TASK = 'e7000000-0000-4000-8000-000000000001'
const SEARCH_URL = 'https://api.hubapi.com/crm/objects/2026-09/contacts/search'

let db: FakeSupabase
let attempts = 0

type Step = Partial<ModelTurnResult> | Error | ((request: ModelTurnRequest) => Partial<ModelTurnResult>)

function gateway(steps: Step[]): ModelGateway & { requests: ModelTurnRequest[] } {
  const requests: ModelTurnRequest[] = []
  return {
    provider: 'anthropic',
    requests,
    turn: vi.fn(async (request: ModelTurnRequest) => {
      requests.push({ ...request, messages: [...request.messages] })
      const next = steps.shift()
      if (!next) throw new Error('no more scripted steps')
      if (next instanceof Error) throw next
      const step = typeof next === 'function' ? next(request) : next
      return { text: '', toolCalls: [], stopReason: 'end_turn' as const, model: 'claude-sonnet-5-5', usage: { inputTokens: 2000, outputTokens: 200 }, assistantContent: [], ...step }
    }),
    structured: vi.fn(),
  }
}

const executionId = () => (db.tables.tool_executions ?? [])[0]?.id as string

function seedTask(overrides: Record<string, unknown> = {}) {
  ;(db.tables.tasks ??= []).push({
    id: TASK,
    organization_id: ORG,
    employee_id: EMPLOYEE,
    employee_version_id: VERSION,
    title: 'Is dana@example.com already in HubSpot?',
    instructions: 'Check the CRM and tell me.',
    status: 'queued',
    max_attempts: 3,
    attempt_count: 0,
    created_by: USER,
    cancel_requested_at: null,
    ...overrides,
  })
}

/** Stands in for claim_employee_tasks: one claim per call while the task is queued. */
function installClaim() {
  db.rpcHandlers.claim_employee_tasks = () => {
    const task = db.tables.tasks!.find((row) => row.id === TASK)!
    if (task.status !== 'queued') return { data: [], error: null }
    let attempt = (db.tables.task_attempts ?? []).find((row) => row.task_id === TASK && row.status === 'running')
    const newAttempt = !attempt
    if (!attempt) {
      attempts += 1
      attempt = { id: `e8000000-0000-4000-8000-00000000000${attempts}`, organization_id: ORG, task_id: TASK, attempt_number: attempts, status: 'running', checkpoint: null }
      ;(db.tables.task_attempts ??= []).push(attempt)
      task.attempt_count = attempts
    }
    task.status = 'running'
    task.lease_expires_at = 'later'
    return { data: [{ task_id: TASK, organization_id: ORG, attempt_id: attempt.id, attempt_number: attempt.attempt_number, new_attempt: newAttempt, recovered: false }], error: null }
  }
}

async function setup(steps: Step[]) {
  const recorder = recordingFetch([[SEARCH_URL, () => jsonResponse(200, { total: 1, results: [{ id: '501', properties: { email: 'dana@example.com', firstname: 'Dana' } }] })]])
  const { runtime } = testRuntime(db, recorder.fetch)
  await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
  const model = gateway(steps)
  const deps: TaskRuntimeDeps = { admin: db as never, gateway: model, integrations: runtime, embedder: null, sleep: async () => {} }
  return { deps, model, requests: recorder.requests }
}

beforeEach(() => {
  db = new FakeSupabase()
  attempts = 0
  db.uniqueKeys.tool_executions = [['organization_id', 'idempotency_key']]
  allowRateLimits(db)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const draft = buildTemplateDraft(EMPLOYEE_TEMPLATES.find((template) => template.key === 'sales_operations')!, listEmployeeTools(), (provider) =>
    provider === 'hubspot' ? HUBSPOT_ID : provider === 'slack' ? SLACK_ID : null,
  )
  db.tables.organizations = [{ id: ORG, name: 'Acme' }]
  db.tables.ai_employees = [{ id: EMPLOYEE, organization_id: ORG, name: 'Sales Ops', status: 'active' }]
  db.tables.employee_versions = [{ id: VERSION, organization_id: ORG, employee_id: EMPLOYEE, version: 1, instructions: draft.instructions, config: draft.config, config_schema_version: 2 }]
  db.tables.employee_tool_permissions = draft.config.tools.map((grant) => ({
    organization_id: ORG,
    employee_id: EMPLOYEE,
    tool_key: grant.toolKey,
    integration_id: grant.integrationId,
    decision: grant.approval,
  }))
  seedTask()
  installClaim()
})

const search = { toolCalls: [{ id: 'call-search', name: 'hubspot__contacts__search', input: { email: 'dana@example.com' } }], stopReason: 'tool_use' as const }
const finish = (receipts: () => string[], summary = 'Dana is already in HubSpot (contact 501); nothing to create.') => () => ({
  toolCalls: [{ id: 'call-finish', name: 'finish_task', input: { status: 'completed', summary, receipts: receipts() } }],
  stopReason: 'tool_use' as const,
})

function task() {
  return db.tables.tasks!.find((row) => row.id === TASK)!
}

function events() {
  return (db.tables.execution_events ?? []).map((row) => row.event_type)
}

describe('running an employee task', () => {
  it('completes a bounded task with a real authorized tool call, verified against the executor’s records', async () => {
    const { deps, requests } = await setup([search, finish(() => [executionId()])])
    const { claimed, results } = await processEmployeeTasks(deps)
    expect(claimed).toBe(1)
    expect(results).toEqual([expect.objectContaining({ taskId: TASK, status: 'succeeded', verification: expect.objectContaining({ status: 'verified' }) })])

    expect(requests).toHaveLength(1)
    expect(db.tables.tool_executions![0]).toMatchObject({ task_id: TASK, employee_id: EMPLOYEE, tool_key: 'hubspot.contacts.search', status: 'succeeded', idempotency_key: `task:${TASK}:call-search` })
    expect(task()).toMatchObject({ status: 'succeeded', lease_expires_at: null, error: null })
    expect(task().result).toMatchObject({ outcome: 'completed', report: { receipts: [executionId()] }, verification: { status: 'verified' } })
    expect(db.tables.task_attempts![0]).toMatchObject({ status: 'succeeded', turn_count: 2, tool_call_count: 1, model: 'claude-sonnet-5-5' })
    expect(db.tables.task_attempts![0]!.checkpoint).toMatchObject({ version: 1, turns: 2 })
    expect(events()).toEqual(expect.arrayContaining(['task.started', 'model.turn', 'tool.called', 'task.verified', 'task.succeeded']))
    expect(db.tables.task_evidence).toEqual([expect.objectContaining({ kind: 'tool_result', tool_execution_id: executionId(), tool_key: 'hubspot.contacts.search' })])
    const usage = db.tables.usage_records!
    expect(usage.filter((row) => row.metric === 'model_cost')).toHaveLength(2)
    expect(usage.find((row) => row.metric === 'task_completed')).toMatchObject({ task_id: TASK, employee_id: EMPLOYEE })

    for (const query of db.queries.filter((query) => query.operation !== 'insert' && query.operation !== 'upsert')) {
      expect(query.filters, `${query.table} ${query.operation}`).toContainEqual(query.table === 'organizations' ? ['id', 'eq', ORG] : ['organization_id', 'eq', ORG])
    }
  })

  it('frames the provider’s data as untrusted in what the model sees next', async () => {
    const { deps, model } = await setup([search, finish(() => [executionId()])])
    await processEmployeeTasks(deps)
    const toolResults = model.requests[1]!.messages.at(-1) as { results: { content: string }[] }
    expect(toolResults.results[0]!.content).toMatch(/^<tool_result tool="hubspot\.contacts\.search" trust="untrusted">/)
    expect(model.requests[0]!.system).toContain('## Platform rules')
    expect(model.requests[0]!.system).not.toContain('test run in the playground')
  })

  it('fails the task when the employee claims an action that never happened', async () => {
    const { deps } = await setup([finish(() => ['00000000-0000-4000-8000-00000000dead'], 'I created Dana in HubSpot.')])
    const { results } = await processEmployeeTasks(deps)
    expect(results[0]).toMatchObject({ status: 'failed', failure: { code: 'verification_failed', class: 'task' } })
    expect(task()).toMatchObject({ status: 'failed', error: { code: 'verification_failed' } })
    expect(task().result).toMatchObject({ verification: { status: 'failed' } })
  })

  it('waits for approval of a write, then resumes from the checkpoint once the action has run', async () => {
    const upsert = { toolCalls: [{ id: 'call-upsert', name: 'hubspot__contacts__upsert', input: { email: 'new@example.com', firstName: 'New' } }], stopReason: 'tool_use' as const }
    const { deps, model } = await setup([upsert, finish(() => [executionId()], 'Created the contact for new@example.com.')])
    const first = await processEmployeeTasks(deps)
    expect(first.results[0]).toMatchObject({ status: 'waiting_approval' })
    expect(task()).toMatchObject({ status: 'waiting_approval', lease_expires_at: null })
    expect(db.tables.approval_requests![0]).toMatchObject({ task_id: TASK, employee_id: EMPLOYEE, employee_version_id: VERSION })
    expect(db.tables.task_attempts![0]!.status).toBe('running')

    // Approved and run by the executor (simulated), which re-queues the task (SQL trigger, pgTAP 009).
    Object.assign(db.tables.tool_executions![0]!, { status: 'succeeded', output_redacted: { id: '901', email: 'new@example.com' } })
    task().status = 'queued'

    const second = await processEmployeeTasks(deps)
    expect(second.results[0]).toMatchObject({ status: 'succeeded', verification: expect.objectContaining({ status: 'verified' }) })
    expect(db.tables.task_attempts).toHaveLength(1)
    expect(events()).toEqual(expect.arrayContaining(['task.waiting_approval', 'task.resumed', 'tool.approval_result']))
    // The resumed model call got the approved action's result for the call it made earlier.
    const toolResults = model.requests[1]!.messages.at(-1) as { results: { toolCallId: string; content: string }[] }
    expect(toolResults.results).toEqual([expect.objectContaining({ toolCallId: 'call-upsert', content: expect.stringContaining('Receipt:') })])
  })

  it('retries a temporary model failure as a new attempt, a bounded number of times', async () => {
    const busy = () => new ModelError('overloaded', 'Busy.', true)
    const { deps } = await setup([busy(), busy(), busy()])
    const { results } = await processEmployeeTasks(deps)
    expect(results[0]).toMatchObject({ status: 'queued', failure: { code: 'overloaded', class: 'transient' } })
    expect(task()).toMatchObject({ status: 'queued', lease_expires_at: null, scheduled_at: expect.any(String) })
    expect(db.tables.task_attempts![0]).toMatchObject({ status: 'failed', error: { code: 'overloaded' } })
    expect(events()).toContain('task.retry_scheduled')

    // The last attempt gives up.
    task().attempt_count = 3
    attempts = 2
    deps.gateway = gateway([busy(), busy(), busy()])
    const last = await processEmployeeTasks(deps)
    expect(last.results[0]).toMatchObject({ status: 'failed', failure: { code: 'overloaded' } })
    expect(task().status).toBe('failed')
  })

  it('does not retry permanent failures or limits', async () => {
    const { deps } = await setup([new ModelError('auth', 'Bad key.')])
    const { results } = await processEmployeeTasks(deps)
    expect(results[0]).toMatchObject({ status: 'failed', failure: { code: 'auth', class: 'permanent' } })

    db.tables.tasks = []
    db.tables.task_attempts = []
    attempts = 0
    seedTask()
    db.tables.usage_records = [{ organization_id: ORG, employee_id: EMPLOYEE, metric: 'model_cost', cost_micros: 999_000_000, occurred_at: new Date().toISOString() }]
    const broke = await processEmployeeTasks({ ...deps, gateway: gateway([]) })
    expect(broke.results[0]).toMatchObject({ status: 'failed', failure: { code: 'budget_exhausted', class: 'limit' } })
  })

  it('stops a task whose employee was paused', async () => {
    db.tables.ai_employees![0]!.status = 'paused'
    const { deps, model } = await setup([search])
    const { results } = await processEmployeeTasks(deps)
    expect(results[0]).toMatchObject({ status: 'cancelled', failure: { code: 'employee_inactive' } })
    expect(task()).toMatchObject({ status: 'cancelled', lease_expires_at: null })
    expect(model.turn).not.toHaveBeenCalled()
  })

  it('ends the task when its progress can’t be saved because it contains something credential-shaped', async () => {
    const { deps } = await setup([search])
    db.errorFor = (table, operation) => (table === 'task_attempts' && operation === 'update' ? { code: '23514' } : null)
    const { results } = await processEmployeeTasks(deps)
    expect(results[0]).toMatchObject({ status: 'failed', failure: { code: 'not_recorded', class: 'permanent' } })
  })
})

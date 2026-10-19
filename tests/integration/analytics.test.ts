// Analytics against a real PostgreSQL with every migration applied: tasks run
// through the real runner and executor (scripted model, fake HubSpot), people
// act through direct calls as themselves, and the numbers are then read the
// way the analytics pages read them (server/queries under a member's session).
//
// Checked: each metric's value against what happened; that every count's
// evidence lists exactly as many rows as the count (and a rate's numerator
// and denominator likewise); outcomes recorded from the succeeded action with
// links to it; the SQL and TypeScript outcome rules agreeing; and that no
// member of another workspace, and no viewer for model usage, reads anything.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scopeMetrics, type MetricValue } from '@/modules/analytics/domain/calculations'
import { METRICS, type EvidenceRef } from '@/modules/analytics/domain/metrics'
import { outcomesForAction } from '@/modules/analytics/domain/outcomes'
import type { AnalyticsPeriod } from '@/modules/analytics/domain/period'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import type { ModelGateway, ModelTurnRequest, ModelTurnResult } from '@/modules/models/server/gateway'
import { processEmployeeTasks, type TaskRuntimeDeps } from '@/modules/tasks/server/runner'

import { jsonResponse } from '../helpers/integration-fixtures'
import { createTestDatabase, EMPLOYEE, LOCAL_DB, OPERATOR, ORG, OTHER_OWNER, OWNER, SEARCH_URL, seedSalesEmployee, UPSERT_URL, VIEWER, type TestDatabase } from './database'

const ADMIN = 'a0000000-0000-4000-8000-000000000002'

let db: TestDatabase
let currentUser = VIEWER

vi.mock('@/lib/supabase/server', () => ({ createUserClient: async () => db.as(currentUser) }))

const { loadAnalytics, loadEvidence } = await import('@/modules/analytics/server/queries')

type Step = Partial<ModelTurnResult> | ((request: ModelTurnRequest) => Partial<ModelTurnResult> | Promise<Partial<ModelTurnResult>>)

function scriptedModel(steps: Step[]): ModelGateway {
  return {
    provider: 'anthropic',
    turn: vi.fn(async (request: ModelTurnRequest) => {
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

beforeEach(async () => {
  if (!LOCAL_DB) return
  db = await createTestDatabase()
  currentUser = VIEWER
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (LOCAL_DB) await db.close()
})

async function assign(title: string) {
  const { data, error } = await db.as(OPERATOR).rpc('assign_employee_task', {
    p_employee_id: EMPLOYEE,
    p_title: title,
    p_instructions: 'Keep the CRM current.',
    p_idempotency_key: `key-${Math.random().toString(36).slice(2, 12)}`,
  })
  expect(error).toBeNull()
  return data as string
}

/**
 * Three tasks for the sales employee:
 *   qualified  upserts a contact as a sales-qualified lead (approved by an admin), then finishes citing it → verified
 *   failed     the employee reports it couldn't complete the work → failed
 *   cancelled  cancelled by the operator before it ran → an intervention
 */
async function scenario() {
  let qualifiedExecution = ''
  const seeded = await seedSalesEmployee(db, [
    [SEARCH_URL, () => jsonResponse(200, { total: 0, results: [] })],
    [UPSERT_URL, () => jsonResponse(201, { id: '901', properties: { email: 'lead@example.com' } })],
  ])
  const model = scriptedModel([
    tools(call('call-upsert', 'hubspot__contacts__upsert', { email: 'lead@example.com', firstName: 'Lee', lifecycleStage: 'salesqualifiedlead' })),
    async () => tools(call('call-finish', 'finish_task', { status: 'completed', summary: 'Created the contact as a qualified lead.', receipts: [qualifiedExecution] })),
    tools(call('call-finish-2', 'finish_task', { status: 'not_completed', summary: 'The account doesn’t exist.', receipts: [] })),
  ])
  const deps: TaskRuntimeDeps = { admin: db.admin as never, gateway: model, integrations: seeded.runtime, embedder: null, sleep: async () => {} }
  const run = async (taskId: string) => (await processEmployeeTasks(deps, 1, taskId)).results.map((result) => result.status)

  const qualified = await assign('Qualify lead@example.com')
  expect(await run(qualified)).toEqual(['waiting_approval'])
  const [approval] = await db.sql<{ id: string; payload_sha256: string; tool_execution_id: string }>('select * from public.approval_requests where task_id = $1', [qualified])
  qualifiedExecution = approval!.tool_execution_id
  expect((await db.as(ADMIN).rpc('decide_approval', { p_request_id: approval!.id, p_decision: 'approved', p_payload_sha256: approval!.payload_sha256 })).error).toBeNull()
  expect((await processApprovedExecutions(seeded.runtime, 5)).results[0]).toMatchObject({ status: 'succeeded' })
  expect(await run(qualified)).toEqual(['succeeded'])

  const failed = await assign('Update the Acme account')
  expect(await run(failed)).toEqual(['failed'])

  const cancelled = await assign('Clean up duplicates')
  expect((await db.as(OPERATOR).rpc('cancel_employee_task', { p_task_id: cancelled })).error).toBeNull()

  return { qualified, failed, cancelled, qualifiedExecution }
}

function period(): AnalyticsPeriod {
  const now = new Date()
  return { key: 'custom', from: new Date(now.getTime() - 3_600_000), to: new Date(now.getTime() + 60_000), label: 'Test window' }
}

describe.skipIf(!LOCAL_DB)('analytics on PostgreSQL', () => {
  it('computes each metric from what happened, records the proven outcomes, and lists the exact rows behind every number', async () => {
    const { qualified, failed, cancelled, qualifiedExecution } = await scenario()
    const window = period()
    const report = await loadAnalytics(ORG, window, { includeUsage: false, now: new Date() })
    expect(report.usage).toBeNull()

    const tasks = report.tasks.find((row) => row.grain === 'employee' && row.key === EMPLOYEE)
    const actions = report.actions.find((row) => row.grain === 'employee' && row.key === EMPLOYEE)
    const metrics = scopeMetrics({ tasks, actions })
    const value = (key: keyof typeof metrics) => (metrics[key] as MetricValue).value

    expect(value('tasks_created')).toBe(3)
    expect(value('tasks_completed')).toBe(1)
    expect(value('tasks_verified')).toBe(1)
    expect(metrics.verified_completion_rate).toMatchObject({ value: 1 / 3, numerator: 1, denominator: 3, smallSample: true })
    expect(value('tasks_failed')).toBe(1)
    expect(value('tasks_cancelled')).toBe(1)
    expect(metrics.intervention_rate).toMatchObject({ numerator: 2, denominator: 3 })
    expect(value('approvals_requested')).toBe(1)
    expect(value('approvals_approved')).toBe(1)
    expect(value('actions_succeeded')).toBe(1) // the upsert (its duplicate check is part of the same action)
    expect(value('actions_failed')).toBe(0)
    expect(value('completion_time_p50')).toBeGreaterThan(0)
    expect(value('task_model_cost')).toBeGreaterThan(0)
    expect(value('task_input_tokens')).toBe(3 * 2000)
    expect(report.failures).toEqual(expect.arrayContaining([expect.objectContaining({ grain: 'employee', key: EMPLOYEE, failure_code: 'not_completed', tasks: 1 })]))

    // The department comes from the employee version that ran the tasks.
    expect(report.tasks.find((row) => row.grain === 'department' && row.key === 'sales')).toMatchObject({ tasks_created: 3, tasks_completed: 1 })

    // Outcomes: the succeeded upsert proved a new contact and a qualified lead, linked to the action and task.
    const outcomes = await db.sql<{ outcome_key: string; subject: string; tool_execution_id: string; task_id: string; employee_id: string }>(
      'select outcome_key, subject, tool_execution_id, task_id, employee_id from public.outcome_records where tool_execution_id is not null order by outcome_key',
    )
    expect(outcomes).toEqual([
      { outcome_key: 'crm.contact_created', subject: '901', tool_execution_id: qualifiedExecution, task_id: qualified, employee_id: EMPLOYEE },
      { outcome_key: 'crm.lead_qualified', subject: '901', tool_execution_id: qualifiedExecution, task_id: qualified, employee_id: EMPLOYEE },
    ])
    expect(report.outcomes.filter((row) => row.grain === 'employee' && row.key === EMPLOYEE).map((row) => [row.outcome_key, row.subjects])).toEqual(
      expect.arrayContaining([
        ['crm.contact_created', 1],
        ['crm.lead_qualified', 1],
      ]),
    )
    const leadEvidence = await loadEvidence(ORG, { source: 'outcome', flag: 'crm.lead_qualified', grain: 'employee', key: EMPLOYEE, period: window })
    expect(leadEvidence.items).toEqual([expect.objectContaining({ tool_execution_id: qualifiedExecution, task_id: qualified, subject: '901' })])

    // Every number is backed by its evidence: a count is the number of rows listed (or, for a sum such as
    // retries, the sum of the listed rows' values); a rate's numerator and denominator likewise.
    const evidenceValue = async (ref: EvidenceRef) => {
      const page = await loadEvidence(ORG, { ...ref, grain: 'employee', key: EMPLOYEE, period: window })
      expect(page.items).toHaveLength(page.total)
      return page.items.reduce((sum, item) => sum + (typeof item[ref.flag] === 'number' ? (item[ref.flag] as number) : 1), 0)
    }
    let checked = 0
    for (const metric of METRICS.filter((candidate) => candidate.grains.includes('employee') && candidate.evidence)) {
      const computed = metrics[metric.key]
      if (!computed) continue
      if (metric.unit === 'count' || metric.unit === 'tokens' || (metric.unit === 'usd' && !metric.denominator)) {
        expect([metric.key, await evidenceValue(metric.evidence!)]).toEqual([metric.key, computed.value])
        checked += 1
      }
      if (metric.denominator) {
        expect([metric.key, await evidenceValue(metric.evidence!)]).toEqual([metric.key, computed.numerator])
        expect([metric.key, await evidenceValue(metric.denominator)]).toEqual([metric.key, computed.denominator])
        checked += 1
      }
    }
    // Every metric with evidence except medians (which list the rows they are taken over) was checked.
    const checkable = METRICS.filter((metric) => metric.grains.includes('employee') && metric.evidence && metric.unit !== 'duration')
    expect(checked).toBe(checkable.length)
    const listed = async (flag: string) => (await loadEvidence(ORG, { source: 'task', flag, grain: 'employee', key: EMPLOYEE, period: window })).items.map((item) => item.task_id)
    expect(await listed('verified')).toEqual([qualified])
    expect(await listed('failed')).toEqual([failed])
    expect((await listed('intervened')).sort()).toEqual([qualified, cancelled].sort())
  })

  it('model usage is for admins; other workspaces read nothing', async () => {
    await scenario()
    const window = period()

    currentUser = VIEWER
    await expect(loadAnalytics(ORG, window, { includeUsage: true, now: new Date() })).rejects.toThrow('model usage (42501)')

    currentUser = OWNER
    const report = await loadAnalytics(ORG, window, { includeUsage: true, now: new Date() })
    // Two model calls for the qualified task, one for the failed task: all from tasks, none from tests.
    expect(report.usage!.summary.taskMicros).toBeGreaterThan(0)
    expect(report.usage!.summary.testMicros).toBe(0)
    expect(report.usage!.summary.inputTokens).toBe(3 * 2000)
    const employeeCost = report.tasks.find((row) => row.grain === 'employee' && row.key === EMPLOYEE)!.cost_micros
    expect(report.usage!.summary.taskMicros).toBe(employeeCost)

    currentUser = OTHER_OWNER
    await expect(loadAnalytics(ORG, window, { includeUsage: false, now: new Date() })).rejects.toThrow('(42501)')
    await expect(loadEvidence(ORG, { source: 'task', flag: 'created', grain: 'organization', period: window })).rejects.toThrow('(42501)')
    // Its own workspace shows only its own (fixture) task.
    const own = await loadAnalytics('b1000000-0000-4000-8000-000000000000', window, { includeUsage: false, now: new Date() })
    expect(own.tasks.find((row) => row.grain === 'organization')!.tasks_created).toBe(1)
  })

  it('the database and the TypeScript outcome rules agree', async () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['hubspot.contacts.upsert', { email: 'a@example.com', lifecycleStage: 'salesqualifiedlead' }, { id: '1', result: 'created' }],
      ['hubspot.contacts.upsert', { email: 'a@example.com', lifecycleStage: 'marketingqualifiedlead' }, { id: '2', result: 'updated' }],
      ['hubspot.contacts.upsert', { email: 'a@example.com', lifecycleStage: 'lead' }, { id: '3', result: 'updated' }],
      ['hubspot.contacts.upsert', { email: 'a@example.com' }, { id: '4', result: 'created' }],
      ['hubspot.notes.create', { contactId: '77', bodyLength: 4 }, { id: 'n', contactId: '77' }],
      ['hubspot.contacts.search', { query: 'x' }, { total: 0 }],
      ['slack.messages.post', { channel: 'C1' }, { channel: 'C1', ts: '1.2' }],
      ['slack.channels.list', {}, { channelCount: 3 }],
    ]
    for (const [toolKey, input, output] of cases) {
      const sql = await db.sql<{ outcome_key: string; subject: string | null }>('select outcome_key, subject from private.action_outcomes($1, $2, $3) order by outcome_key', [
        toolKey,
        JSON.stringify(input),
        JSON.stringify(output),
      ])
      const ts = outcomesForAction(toolKey, input, output)
        .map((outcome) => ({ outcome_key: outcome.outcomeKey, subject: outcome.subject }))
        .sort((left, right) => left.outcome_key.localeCompare(right.outcome_key))
      expect([toolKey, input, sql]).toEqual([toolKey, input, ts])
    }
  })
})

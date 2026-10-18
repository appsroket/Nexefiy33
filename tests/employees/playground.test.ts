// Test runs end to end with an in-memory database and a scripted model:
// the run is recorded with its transcript, checks, tokens and cost; usage
// counts toward the monthly budget; archived employees, exhausted budgets and
// old configuration formats are refused; and every query is scoped to the
// caller's organization.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildTemplateDraft, EMPLOYEE_TEMPLATES } from '@/modules/employees/domain/templates'
import { monthlySpendMicros, runEmployeeTest } from '@/modules/employees/server/playground'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import type { ModelGateway, ModelTurnResult } from '@/modules/models/server/gateway'

import { FakeSupabase } from '../helpers/fake-supabase'

const ORG = 'a1000000-0000-4000-8000-000000000000'
const OTHER_ORG = 'b1000000-0000-4000-8000-000000000000'
const EMPLOYEE = 'a2000000-0000-4000-8000-000000000001'
const VERSION = 'a2000000-0000-4000-8000-000000000002'
const CASE = 'a2000000-0000-4000-8000-0000000000c1'
const actor = { kind: 'user' as const, userId: 'a0000000-0000-4000-8000-000000000003', role: 'operator' as const }
const NOW = new Date('2026-10-18T12:00:00Z')

let db: FakeSupabase

function gateway(steps: Partial<ModelTurnResult>[]): ModelGateway {
  return {
    provider: 'anthropic',
    turn: vi.fn(async () => ({
      text: '',
      toolCalls: [],
      stopReason: 'end_turn' as const,
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 2000, outputTokens: 300 },
      assistantContent: [],
      ...steps.shift(),
    })),
    structured: vi.fn(),
  }
}

function seed({ state = 'testing', configVersion = 2 }: { state?: string; configVersion?: number } = {}) {
  const { config, instructions } = buildTemplateDraft(EMPLOYEE_TEMPLATES.find((template) => template.key === 'knowledge_assistant')!, listEmployeeTools())
  db.tables.organizations = [{ id: ORG, name: 'Acme' }]
  db.tables.ai_employees = [{ id: EMPLOYEE, organization_id: ORG, name: 'Knowledge Assistant', lifecycle_status: state, current_version_id: VERSION }]
  db.tables.employee_versions = [
    {
      id: VERSION,
      organization_id: ORG,
      employee_id: EMPLOYEE,
      version: 3,
      instructions,
      config: configVersion === 2 ? config : { modelTier: 'fast', limits: {} },
      config_schema_version: configVersion,
    },
  ]
  db.tables.employee_test_cases = [
    { id: CASE, organization_id: ORG, employee_id: EMPLOYEE, input: 'What is the refund policy?', expectations: { replyMustMention: ['30 days'] } },
  ]
  db.tables.usage_records = []
  return config
}

const deps = (model: ModelGateway) => ({ admin: db as never, gateway: model, integrations: null, embedder: null, now: () => NOW })

beforeEach(() => {
  db = new FakeSupabase()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('runEmployeeTest', () => {
  it('records a passing test-case run with its checks, transcript, tokens, cost and usage', async () => {
    seed()
    const outcome = await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, testCaseId: CASE }, deps(gateway([{ text: 'Refunds are accepted within 30 days.' }])))
    expect(outcome).toMatchObject({ status: 'finished', result: 'passed', outcome: 'completed', costMicros: 7000, model: 'claude-sonnet-5-5' })

    const [run] = db.tables.employee_test_runs!
    expect(run).toMatchObject({
      organization_id: ORG,
      employee_id: EMPLOYEE,
      version_id: VERSION,
      test_case_id: CASE,
      input: 'What is the refund policy?',
      result: 'passed',
      outcome: 'completed',
      input_tokens: 2000,
      output_tokens: 300,
      cost_micros: 7000,
      created_by: actor.userId,
      finished_at: NOW.toISOString(),
    })
    expect(run!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Mentions “30 days”', passed: true })]))
    expect(db.tables.usage_records!.map((row) => [row.metric, row.quantity, row.cost_micros ?? null])).toEqual([
      ['model_cost', 1, 7000],
      ['model_input_tokens', 2000, null],
      ['model_output_tokens', 300, null],
    ])
    expect(await monthlySpendMicros(db as never, ORG, EMPLOYEE, NOW)).toBe(7000)
  })

  it('fails a test case whose expectation isn’t met, and sends free-form runs to review', async () => {
    seed()
    const failed = await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, testCaseId: CASE }, deps(gateway([{ text: 'I don’t know.' }])))
    expect(failed).toMatchObject({ status: 'finished', result: 'failed' })
    const freeForm = await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, input: 'Summarize the handbook.' }, deps(gateway([{ text: 'Summary.' }])))
    expect(freeForm).toMatchObject({ status: 'finished', result: 'needs_review' })
    expect(db.tables.employee_test_runs![1]).toMatchObject({ test_case_id: null, result: 'needs_review' })
  })

  it('refuses archived employees, old formats, unknown test cases and exhausted budgets without calling the model', async () => {
    const model = gateway([])
    seed({ state: 'archived' })
    expect(await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, input: 'hi' }, deps(model))).toMatchObject({ status: 'refused' })
    seed({ configVersion: 1 })
    expect(await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, input: 'hi' }, deps(model))).toMatchObject({ status: 'refused', message: expect.stringContaining('older configuration') })
    const config = seed()
    expect(
      await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, testCaseId: 'a2000000-0000-4000-8000-0000000000c9' }, deps(model)),
    ).toMatchObject({ status: 'refused' })
    db.tables.usage_records = [
      { organization_id: ORG, employee_id: EMPLOYEE, metric: 'model_cost', cost_micros: config.budget.monthlyUsd * 1_000_000, occurred_at: '2026-10-02T00:00:00.000Z' },
    ]
    expect(await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, input: 'hi' }, deps(model))).toMatchObject({ status: 'refused', message: expect.stringContaining('monthly budget') })
    expect(model.turn).not.toHaveBeenCalled()
    expect(db.tables.employee_test_runs ?? []).toEqual([])
  })

  it('counts only this month’s spending', async () => {
    seed()
    db.tables.usage_records = [
      { organization_id: ORG, employee_id: EMPLOYEE, metric: 'model_cost', cost_micros: 5_000, occurred_at: '2026-09-30T23:59:59.000Z' },
      { organization_id: ORG, employee_id: EMPLOYEE, metric: 'model_cost', cost_micros: 2_000, occurred_at: '2026-10-01T00:00:00.000Z' },
      { organization_id: OTHER_ORG, employee_id: EMPLOYEE, metric: 'model_cost', cost_micros: 9_000, occurred_at: '2026-10-05T00:00:00.000Z' },
    ]
    expect(await monthlySpendMicros(db as never, ORG, EMPLOYEE, NOW)).toBe(2_000)
  })

  it('can’t reach another organization’s employee, and scopes every query', async () => {
    seed()
    expect(await runEmployeeTest({ organizationId: OTHER_ORG, employeeId: EMPLOYEE, actor, input: 'hi' }, deps(gateway([])))).toMatchObject({ status: 'refused' })
    await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, testCaseId: CASE }, deps(gateway([{ text: '30 days' }])))
    for (const query of db.queries) {
      if (query.operation === 'insert' || query.operation === 'upsert') {
        for (const row of [query.values].flat()) expect(row, query.table).toMatchObject({ organization_id: expect.any(String) })
      } else if (query.table === 'organizations') {
        expect(query.filters, query.table).toContainEqual(['id', 'eq', expect.any(String)])
      } else {
        expect(query.filters.some(([column]) => column === 'organization_id'), `${query.operation} ${query.table}`).toBe(true)
      }
    }
  })

  it('marks runs interrupted by a stopped server as errors', async () => {
    seed()
    db.tables.employee_test_runs = [
      { id: 'old', organization_id: ORG, employee_id: EMPLOYEE, result: 'running', started_at: '2026-10-18T11:00:00.000Z' },
      { id: 'recent', organization_id: ORG, employee_id: EMPLOYEE, result: 'running', started_at: '2026-10-18T11:55:00.000Z' },
    ]
    await runEmployeeTest({ organizationId: ORG, employeeId: EMPLOYEE, actor, input: 'hi' }, deps(gateway([{ text: 'ok' }])))
    expect(db.tables.employee_test_runs!.find((run) => run.id === 'old')).toMatchObject({ result: 'error', error: { code: 'interrupted' } })
    expect(db.tables.employee_test_runs!.find((run) => run.id === 'recent')).toMatchObject({ result: 'running' })
  })
})

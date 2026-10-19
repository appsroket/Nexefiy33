// Analytics definitions and calculations, without a database: every metric
// is defined once, says how it is computed and whether it is measured,
// calculated or an estimate, and points at facts columns that exist in the
// migration; rates, medians and the month-end projection follow their stated
// formulas; outcomes are only "measured" when a built action records them;
// nothing claims hours saved or revenue.

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { PROJECTION_MIN_DAYS, projectMonthEnd, rate, scopeMetrics, summarizeUsage, SMALL_SAMPLE, type TaskMetricsRow } from '@/modules/analytics/domain/calculations'
import { evidenceHref, parseEvidenceQuery } from '@/modules/analytics/domain/evidence'
import { METRIC_KEYS, METRICS, NOT_REPORTED } from '@/modules/analytics/domain/metrics'
import { outcomesForAction, OUTCOMES } from '@/modules/analytics/domain/outcomes'
import { exactPeriod, periodFromParams, resolvePeriod } from '@/modules/analytics/domain/period'
import { findAction } from '@/modules/integrations/connectors/registry'

const MIGRATION = readFileSync('supabase/migrations/20261022090000_analytics.sql', 'utf8')

/** The columns a facts function returns, read from the migration. */
function factColumns(fn: string): Map<string, string> {
  const match = new RegExp(`create function private\\.${fn}\\([^)]*\\)\\s*returns table \\(([^;]*?)\\)\\s*language`, 's').exec(MIGRATION)
  if (!match) throw new Error(`no facts function ${fn}`)
  return new Map(
    match[1]!
      .split(',')
      .map((column) => column.trim().split(/\s+/))
      .map(([name, type]) => [name!, type!]),
  )
}

const FACTS = {
  task: factColumns('analytics_task_facts'),
  action: factColumns('analytics_action_facts'),
  run: factColumns('analytics_run_facts'),
  outcome: factColumns('analytics_outcome_facts'),
}

describe('metric definitions', () => {
  it('defines every metric key exactly once, with a description and a method', () => {
    expect(METRICS.map((metric) => metric.key).sort()).toEqual([...METRIC_KEYS].sort())
    for (const metric of METRICS) {
      expect(metric.description.length, metric.key).toBeGreaterThan(20)
      expect(metric.method.length, metric.key).toBeGreaterThan(20)
      expect(metric.grains.length, metric.key).toBeGreaterThan(0)
    }
  })

  it('labels each number honestly: counts are measured, rates and medians calculated, the projection an estimate', () => {
    for (const metric of METRICS) {
      if (metric.unit === 'percent' || metric.unit === 'duration') expect(metric.basis, metric.key).toBe('calculated')
      if (metric.basis === 'measured') expect(['count', 'tokens'], metric.key).toContain(metric.unit)
      // Costs come from list prices, so they are never "measured".
      if (metric.unit === 'usd') expect(metric.basis, metric.key).not.toBe('measured')
    }
    expect(METRICS.filter((metric) => metric.basis === 'estimate').map((metric) => metric.key)).toEqual(['projected_month_model_cost'])
    expect(METRICS.find((metric) => metric.key === 'projected_month_model_cost')!.method).toMatch(/Assumes/)
  })

  it('gives every rate a numerator and denominator, and every number on a fact source its evidence', () => {
    for (const metric of METRICS) {
      if (metric.unit === 'percent') {
        expect(metric.evidence, metric.key).toBeDefined()
        expect(metric.denominator, metric.key).toBeDefined()
      }
      if (!metric.adminOnly) expect(metric.evidence, metric.key).toBeDefined()
    }
  })

  it('points evidence at boolean or count columns that the facts functions really return', () => {
    for (const metric of METRICS) {
      for (const ref of [metric.evidence, metric.denominator]) {
        if (!ref) continue
        const type = FACTS[ref.source].get(ref.flag)
        expect([metric.key, ref.flag, type && /^(boolean|integer|bigint)$/.test(type)]).toEqual([metric.key, ref.flag, true])
      }
    }
  })

  it('reads model usage only for admins and only workspace-wide', () => {
    for (const metric of METRICS.filter((candidate) => candidate.group === 'usage')) {
      expect(metric.adminOnly, metric.key).toBe(true)
      expect(metric.grains).toEqual(['organization'])
    }
  })

  it('never claims hours saved, revenue or ROI, and says why', () => {
    for (const metric of METRICS) expect(`${metric.label} ${metric.description}`, metric.key).not.toMatch(/hours saved|time saved|revenue|ROI|return on/i)
    expect(METRICS.find((metric) => metric.key === 'completion_rate')!.method).toMatch(/says nothing by itself about revenue/)
    expect(NOT_REPORTED.map((item) => item.label)).toEqual(expect.arrayContaining(['Hours saved', 'Revenue or deals won']))
  })
})

describe('outcome definitions', () => {
  it('marks an outcome measured only when built actions record it', () => {
    for (const outcome of OUTCOMES) {
      if (outcome.support === 'measured') {
        expect(outcome.toolKeys.length, outcome.key).toBeGreaterThan(0)
        for (const toolKey of outcome.toolKeys) expect(findAction(toolKey), `${outcome.key} → ${toolKey}`).toBeDefined()
        expect(outcome.requires).toBeUndefined()
      } else {
        expect(outcome.toolKeys).toEqual([])
        expect(outcome.requires, outcome.key).toMatch(/isn’t built/)
      }
    }
    expect(OUTCOMES.filter((outcome) => outcome.support === 'unsupported').map((outcome) => outcome.key)).toEqual(['calendar.appointment_booked', 'support.ticket_resolved'])
  })

  it('names in the SQL every outcome the TypeScript rules can produce', () => {
    for (const outcome of OUTCOMES.filter((candidate) => candidate.support === 'measured')) expect(MIGRATION).toContain(`'${outcome.key}'`)
  })

  it('records what a succeeded action proves, and nothing personal', () => {
    expect(outcomesForAction('hubspot.contacts.upsert', { email: 'a@example.com', lifecycleStage: 'salesqualifiedlead' }, { id: '7', result: 'created', email: 'a@example.com' })).toEqual([
      { outcomeKey: 'crm.contact_created', subject: '7' },
      { outcomeKey: 'crm.lead_qualified', subject: '7' },
    ])
    expect(outcomesForAction('hubspot.contacts.upsert', { email: 'a@example.com', lifecycleStage: 'lead' }, { id: '7', result: 'updated' })).toEqual([])
    expect(outcomesForAction('hubspot.contacts.search', {}, {})).toEqual([])
    expect(outcomesForAction('slack.messages.post', { channel: 'C1' }, { channel: 'C1', ts: '1' })).toEqual([{ outcomeKey: 'messaging.message_sent', subject: 'C1' }])
  })
})

const row = (overrides: Partial<TaskMetricsRow>): TaskMetricsRow => ({
  grain: 'organization',
  key: 'org',
  tasks_created: 0,
  tasks_open: 0,
  tasks_finished: 0,
  tasks_completed: 0,
  tasks_verified: 0,
  tasks_needs_review: 0,
  tasks_failed: 0,
  tasks_cancelled: 0,
  tasks_skipped: 0,
  tasks_completed_by_person: 0,
  tasks_retried: 0,
  retries: 0,
  recovery_attempted: 0,
  tasks_recovered: 0,
  approvals_requested: 0,
  approvals_approved: 0,
  approvals_rejected: 0,
  approvals_expired: 0,
  tasks_intervened: 0,
  person_controls: 0,
  tasks_handoff: 0,
  tasks_responded: 0,
  response_p50_ms: null,
  duration_p50_ms: null,
  duration_p90_ms: null,
  active_p50_ms: null,
  active_ms: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_micros: 0,
  ...overrides,
})

describe('calculations', () => {
  it('computes rates over their stated denominators and flags small samples', () => {
    const metrics = scopeMetrics({
      tasks: row({ tasks_created: 40, tasks_open: 5, tasks_finished: 30, tasks_completed: 24, tasks_verified: 18, tasks_intervened: 10, recovery_attempted: 4, tasks_recovered: 3, cost_micros: 1_200_000 }),
    })
    expect(metrics.verified_completion_rate).toMatchObject({ value: 0.6, numerator: 18, denominator: 30, smallSample: false })
    expect(metrics.completion_rate!.value).toBe(0.8)
    expect(metrics.intervention_rate).toMatchObject({ value: 0.25, denominator: 40 })
    expect(metrics.recovery_rate).toMatchObject({ value: 0.75, smallSample: true })
    expect(metrics.cost_per_completed_task!.value).toBe(50_000)
  })

  it('shows no rate or median rather than a misleading zero when there is nothing to compute it from', () => {
    const metrics = scopeMetrics({})
    expect(metrics.tasks_created!.value).toBe(0)
    expect(metrics.verified_completion_rate!.value).toBeNull()
    expect(metrics.integration_error_rate!.value).toBeNull()
    expect(metrics.completion_time_p50!.value).toBeNull()
    expect(metrics.cost_per_completed_task!.value).toBeNull()
    // Run metrics exist only where runs were read (the organization and workflows).
    expect(metrics.runs_started).toBeUndefined()
    expect(rate(0, 0)).toMatchObject({ value: null, smallSample: false })
    expect(rate(1, SMALL_SAMPLE).smallSample).toBe(false)
  })

  it('computes the integration error rate over actions that ran to an end', () => {
    const metrics = scopeMetrics({ actions: { grain: 'organization', key: 'org', error_code: null, actions_requested: 12, actions_succeeded: 8, actions_failed: 2, actions_settled: 10, actions_rejected: 1, actions_withdrawn: 1 } })
    expect(metrics.integration_error_rate).toMatchObject({ value: 0.2, numerator: 2, denominator: 10 })
  })

  it('splits model spend by source and model', () => {
    const summary = summarizeUsage([
      { source: 'tasks', model: 'claude-sonnet-5-5', cost_micros: 900, input_tokens: 10, output_tokens: 5, calls: 3 },
      { source: 'tests', model: 'claude-sonnet-5-5', cost_micros: 100, input_tokens: 1, output_tokens: 1, calls: 1 },
      { source: 'tasks', model: 'claude-haiku-5-5', cost_micros: 50, input_tokens: 4, output_tokens: 2, calls: 2 },
    ])
    expect(summary).toMatchObject({ totalMicros: 1050, taskMicros: 950, testMicros: 100, calls: 6 })
    expect(summary.byModel[0]).toEqual({ model: 'claude-sonnet-5-5', costMicros: 1000, calls: 4 })
  })

  it('projects month-end spend from the average daily rate so far, and not before the third day', () => {
    // 10 October, 12:00 UTC: 9.5 days elapsed of 31.
    const projection = projectMonthEnd(9_500_000, new Date(Date.UTC(2026, 9, 10, 12)))
    expect(projection).toMatchObject({ value: 31_000_000, daysElapsed: 9.5, daysInMonth: 31 })
    const early = projectMonthEnd(1_000_000, new Date(Date.UTC(2026, 1, 2, 12)))
    expect(early.value).toBeNull()
    expect(early.reason).toContain(String(PROJECTION_MIN_DAYS))
  })
})

describe('periods and evidence links', () => {
  const now = new Date(Date.UTC(2026, 9, 19, 15, 30))

  it('resolves periods in UTC', () => {
    expect(resolvePeriod('7d', now).from).toEqual(new Date(Date.UTC(2026, 9, 12, 15, 30)))
    expect(resolvePeriod('month', now)).toMatchObject({ from: new Date(Date.UTC(2026, 9, 1)), to: now })
    expect(resolvePeriod('last_month', now)).toMatchObject({ from: new Date(Date.UTC(2026, 8, 1)), to: new Date(Date.UTC(2026, 9, 1)) })
    expect(resolvePeriod('last_month', new Date(Date.UTC(2026, 0, 5))).from).toEqual(new Date(Date.UTC(2025, 11, 1)))
    expect(periodFromParams({ period: 'nonsense' }, now).key).toBe('30d')
  })

  it('accepts only exact windows the database accepts', () => {
    expect(exactPeriod({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' })).toMatchObject({ key: 'custom' })
    expect(exactPeriod({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toBeNull()
    expect(exactPeriod({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).toBeNull()
    expect(exactPeriod({ from: 'yesterday', to: '2026-10-01T00:00:00Z' })).toBeNull()
  })

  it('round-trips an evidence link with its exact window', () => {
    const period = resolvePeriod('30d', now)
    const href = evidenceHref({ source: 'task', flag: 'verified', grain: 'employee', key: 'a2000000-0000-4000-8000-000000000001', period, title: 'Verified completions' })
    const params = Object.fromEntries(new URL(href, 'https://app.example').searchParams)
    expect(parseEvidenceQuery(params)).toEqual({
      source: 'task',
      flag: 'verified',
      grain: 'employee',
      key: 'a2000000-0000-4000-8000-000000000001',
      period: { from: period.from, to: period.to },
      title: 'Verified completions',
      page: 1,
    })
  })

  it('rejects evidence links it can’t answer', () => {
    const base = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }
    expect(parseEvidenceQuery({ ...base, source: 'audit', flag: 'created' })).toBeNull()
    expect(parseEvidenceQuery({ ...base, source: 'task', flag: 'Created; drop' })).toBeNull()
    expect(parseEvidenceQuery({ ...base, source: 'task', flag: 'created', grain: 'employee' })).toBeNull()
    expect(parseEvidenceQuery({ source: 'task', flag: 'created' })).toBeNull()
  })
})

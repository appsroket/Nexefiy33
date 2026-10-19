// Turning the database's aggregates into the numbers on the page. Counts
// come from the SQL functions unchanged; rates, averages and the one estimate
// are computed here, from those counts, by the formulas in metrics.ts.

import type { Grain, MetricKey } from './metrics'

/** One row of public.analytics_task_metrics. */
export interface TaskMetricsRow {
  grain: Grain
  key: string
  tasks_created: number
  tasks_open: number
  tasks_finished: number
  tasks_completed: number
  tasks_verified: number
  tasks_needs_review: number
  tasks_failed: number
  tasks_cancelled: number
  tasks_skipped: number
  tasks_completed_by_person: number
  tasks_retried: number
  retries: number
  recovery_attempted: number
  tasks_recovered: number
  approvals_requested: number
  approvals_approved: number
  approvals_rejected: number
  approvals_expired: number
  tasks_intervened: number
  person_controls: number
  tasks_handoff: number
  tasks_responded: number
  response_p50_ms: number | null
  duration_p50_ms: number | null
  duration_p90_ms: number | null
  active_p50_ms: number | null
  active_ms: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
}

/** One row of public.analytics_action_metrics. */
export interface ActionMetricsRow {
  grain: Grain | 'provider' | 'provider_error'
  key: string
  error_code: string | null
  actions_requested: number
  actions_succeeded: number
  actions_failed: number
  actions_settled: number
  actions_rejected: number
  actions_withdrawn: number
}

/** One row of public.analytics_workflow_metrics. */
export interface WorkflowMetricsRow {
  grain: 'organization' | 'workflow'
  key: string
  runs_started: number
  runs_open: number
  runs_finished: number
  runs_succeeded: number
  runs_failed: number
  runs_cancelled: number
  runs_rejected: number
  runs_with_failed_step: number
  steps_failed: number
  duration_p50_ms: number | null
  duration_p90_ms: number | null
  cost_micros: number
}

/** One row of public.analytics_outcome_metrics. */
export interface OutcomeMetricsRow {
  grain: Grain
  key: string
  outcome_key: string
  records: number
  quantity: number
  subjects: number
}

/** One row of public.analytics_task_failures. */
export interface FailureRow {
  grain: Grain
  key: string
  failure_class: string
  failure_code: string
  tasks: number
}

/** One row of public.analytics_model_usage. */
export interface ModelUsageRow {
  source: 'tasks' | 'tests' | 'other'
  model: string
  cost_micros: number
  input_tokens: number
  output_tokens: number
  calls: number
}

/** Below this many rows a rate or percentile is shown with a small-sample warning. */
export const SMALL_SAMPLE = 10

export interface MetricValue {
  /** Null when there is nothing to compute it from (no rows, an empty denominator). */
  value: number | null
  numerator?: number
  denominator?: number
  /** How many rows the value rests on (rates: the denominator; medians: the rows). */
  sample?: number
  smallSample?: boolean
}

function count(value: number | null | undefined): MetricValue {
  return { value: value ?? 0 }
}

/** numerator ÷ denominator (a fraction for rates, an amount for averages); null when the denominator is 0. */
export function rate(numerator: number, denominator: number): MetricValue {
  return {
    value: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
    sample: denominator,
    smallSample: denominator > 0 && denominator < SMALL_SAMPLE,
  }
}

function percentile(value: number | null, sample: number): MetricValue {
  return { value: sample > 0 ? value : null, sample, smallSample: sample > 0 && sample < SMALL_SAMPLE }
}

export interface ScopeInputs {
  tasks?: TaskMetricsRow
  actions?: ActionMetricsRow
  runs?: WorkflowMetricsRow
}

export type ScopeMetrics = Partial<Record<MetricKey, MetricValue>>

const EMPTY_TASKS: TaskMetricsRow = {
  grain: 'organization',
  key: '',
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
}

/** Task, action and (for the organization and workflows) run metrics of one scope. */
export function scopeMetrics(inputs: ScopeInputs): ScopeMetrics {
  const task = inputs.tasks ?? EMPTY_TASKS
  const metrics: ScopeMetrics = {
    tasks_created: count(task.tasks_created),
    tasks_completed: count(task.tasks_completed),
    tasks_verified: count(task.tasks_verified),
    verified_completion_rate: rate(task.tasks_verified, task.tasks_finished),
    completion_rate: rate(task.tasks_completed, task.tasks_finished),
    tasks_open: count(task.tasks_open),
    tasks_completed_by_person: count(task.tasks_completed_by_person),
    tasks_failed: count(task.tasks_failed),
    tasks_cancelled: count(task.tasks_cancelled),
    tasks_retried: count(task.tasks_retried),
    retries: count(task.retries),
    tasks_recovered: count(task.tasks_recovered),
    recovery_rate: rate(task.tasks_recovered, task.recovery_attempted),
    intervention_rate: rate(task.tasks_intervened, task.tasks_created),
    tasks_intervened: count(task.tasks_intervened),
    approvals_requested: count(task.approvals_requested),
    approvals_approved: count(task.approvals_approved),
    approvals_rejected: count(task.approvals_rejected),
    approvals_expired: count(task.approvals_expired),
    handoffs: count(task.tasks_handoff),
    completion_time_p50: percentile(task.duration_p50_ms, task.tasks_completed),
    completion_time_p90: percentile(task.duration_p90_ms, task.tasks_completed),
    active_time_p50: percentile(task.active_p50_ms, task.tasks_completed),
    response_time_p50: percentile(task.response_p50_ms, task.tasks_responded),
    task_model_cost: count(task.cost_micros),
    cost_per_completed_task: rate(task.cost_micros, task.tasks_completed),
    task_input_tokens: count(task.input_tokens),
    task_output_tokens: count(task.output_tokens),
  }
  const action = inputs.actions
  metrics.actions_requested = count(action?.actions_requested)
  metrics.actions_succeeded = count(action?.actions_succeeded)
  metrics.actions_failed = count(action?.actions_failed)
  metrics.integration_error_rate = rate(action?.actions_failed ?? 0, action?.actions_settled ?? 0)

  const run = inputs.runs
  if (run) {
    const runFinished = run.runs_finished
    metrics.runs_started = count(run.runs_started)
    metrics.runs_succeeded = count(run.runs_succeeded)
    metrics.runs_failed = count(run.runs_failed)
    metrics.run_success_rate = rate(run.runs_succeeded, runFinished)
    metrics.run_duration_p50 = percentile(run.duration_p50_ms, run.runs_succeeded)
    metrics.run_duration_p90 = percentile(run.duration_p90_ms, run.runs_succeeded)
    metrics.runs_with_failed_step = count(run.runs_with_failed_step)
    metrics.run_model_cost = count(run.cost_micros)
  }
  return metrics
}

export interface UsageSummary {
  totalMicros: number
  testMicros: number
  taskMicros: number
  otherMicros: number
  inputTokens: number
  outputTokens: number
  calls: number
  byModel: { model: string; costMicros: number; calls: number }[]
}

export function summarizeUsage(rows: readonly ModelUsageRow[]): UsageSummary {
  const sum = (source: ModelUsageRow['source']) => rows.filter((row) => row.source === source).reduce((total, row) => total + row.cost_micros, 0)
  const models = new Map<string, { costMicros: number; calls: number }>()
  for (const row of rows) {
    const current = models.get(row.model) ?? { costMicros: 0, calls: 0 }
    models.set(row.model, { costMicros: current.costMicros + row.cost_micros, calls: current.calls + row.calls })
  }
  return {
    totalMicros: rows.reduce((total, row) => total + row.cost_micros, 0),
    testMicros: sum('tests'),
    taskMicros: sum('tasks'),
    otherMicros: sum('other'),
    inputTokens: rows.reduce((total, row) => total + row.input_tokens, 0),
    outputTokens: rows.reduce((total, row) => total + row.output_tokens, 0),
    calls: rows.reduce((total, row) => total + row.calls, 0),
    byModel: [...models.entries()].map(([model, value]) => ({ model, ...value })).sort((left, right) => right.costMicros - left.costMicros),
  }
}

/** Days before a month-end projection is shown at all. */
export const PROJECTION_MIN_DAYS = 3

export interface Projection {
  value: number | null
  monthToDateMicros: number
  daysElapsed: number
  daysInMonth: number
  /** Why there is no value. */
  reason?: string
}

/**
 * Month-end spend if the rest of the month runs at the average daily rate so
 * far (UTC). An estimate: it assumes usage stays the same.
 */
export function projectMonthEnd(monthToDateMicros: number, now: Date): Projection {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const daysElapsed = (now.getTime() - start) / 86_400_000
  if (daysElapsed < PROJECTION_MIN_DAYS) {
    return { value: null, monthToDateMicros, daysElapsed, daysInMonth, reason: `Shown once ${PROJECTION_MIN_DAYS} days of the month have passed.` }
  }
  return { value: Math.round((monthToDateMicros / daysElapsed) * daysInMonth), monthToDateMicros, daysElapsed, daysInMonth }
}

export interface OutcomeValue {
  outcomeKey: string
  value: number
  records: number
  subjects: number
}

/** Outcome values of one scope; `countBy` says whether each counts records or distinct subjects. */
export function scopeOutcomes(rows: readonly OutcomeMetricsRow[], grain: Grain, key: string, countBy: (outcomeKey: string) => 'records' | 'subjects'): OutcomeValue[] {
  return rows
    .filter((row) => row.grain === grain && row.key === key)
    .map((row) => ({
      outcomeKey: row.outcome_key,
      value: countBy(row.outcome_key) === 'subjects' ? row.subjects : row.records,
      records: row.records,
      subjects: row.subjects,
    }))
}

export function formatPercent(fraction: number): string {
  const percent = fraction * 100
  return `${percent >= 10 || percent === 0 ? Math.round(percent) : percent.toFixed(1)}%`
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

// What every analytics number means, how it is computed, and which persisted
// rows it comes from (Zod-free: client components import this).
//
// Three kinds of number, always labelled:
//   measured    a count of records the platform wrote when the thing happened
//               (a task finishing, an action succeeding, a person approving);
//   calculated  derived from measured records by the fixed formula given in
//               its method (a rate, a median, a cost at list prices);
//   estimate    involves an assumption about something not observed (the
//               method names the assumption).
//
// Task metrics cover AI employee tasks *created* in the period and what has
// happened to them so far, so recent tasks may still be open. Actions are
// counted by when they were requested, workflow runs by when they were
// queued, outcomes by when they happened, model usage by when it was used.
// The SQL functions in supabase/migrations/20261019202348_analytics.sql
// compute the counts; `evidence` names the fact source and flag whose rows
// make up each number (the evidence page lists exactly those rows).

export const METRIC_BASES = ['measured', 'calculated', 'estimate'] as const
export type MetricBasis = (typeof METRIC_BASES)[number]

export const BASIS_LABELS: Record<MetricBasis, string> = {
  measured: 'Measured',
  calculated: 'Calculated',
  estimate: 'Estimate',
}

export const BASIS_DESCRIPTIONS: Record<MetricBasis, string> = {
  measured: 'Counted from records the platform wrote when it happened.',
  calculated: 'Derived from measured records by a fixed formula (a rate, a median, a cost at list prices).',
  estimate: 'Depends on an assumption about something that wasn’t observed; the method says which.',
}

export const GRAINS = ['organization', 'department', 'employee', 'workflow'] as const
export type Grain = (typeof GRAINS)[number]
/** Integration errors can also be read per provider, or per provider and error code ("slack:rate_limited"). */
export type EvidenceGrain = Grain | 'provider' | 'provider_error'

export const FACT_SOURCES = ['task', 'action', 'run', 'outcome'] as const
export type FactSource = (typeof FACT_SOURCES)[number]

export interface EvidenceRef {
  source: FactSource
  /** A boolean or count column of the facts (for outcomes: the outcome key). */
  flag: string
}

export type MetricUnit = 'count' | 'percent' | 'duration' | 'usd' | 'tokens'

export const METRIC_GROUPS = ['work', 'reliability', 'people', 'time', 'cost', 'integrations', 'workflows', 'usage'] as const
export type MetricGroup = (typeof METRIC_GROUPS)[number]

export const METRIC_GROUP_LABELS: Record<MetricGroup, string> = {
  work: 'Work',
  reliability: 'Failures, retries and recovery',
  people: 'Human intervention',
  time: 'Execution time',
  cost: 'Model usage of these tasks',
  integrations: 'Integration actions',
  workflows: 'Workflow performance',
  usage: 'All model usage',
}

export const METRIC_KEYS = [
  'tasks_created',
  'tasks_completed',
  'tasks_verified',
  'verified_completion_rate',
  'completion_rate',
  'tasks_open',
  'tasks_completed_by_person',
  'tasks_failed',
  'tasks_cancelled',
  'tasks_retried',
  'retries',
  'tasks_recovered',
  'recovery_rate',
  'intervention_rate',
  'tasks_intervened',
  'approvals_requested',
  'approvals_approved',
  'approvals_rejected',
  'approvals_expired',
  'handoffs',
  'completion_time_p50',
  'completion_time_p90',
  'active_time_p50',
  'response_time_p50',
  'task_model_cost',
  'cost_per_completed_task',
  'task_input_tokens',
  'task_output_tokens',
  'actions_requested',
  'actions_succeeded',
  'actions_failed',
  'integration_error_rate',
  'runs_started',
  'runs_succeeded',
  'runs_failed',
  'run_success_rate',
  'run_duration_p50',
  'run_duration_p90',
  'runs_with_failed_step',
  'run_model_cost',
  'model_cost_total',
  'model_cost_tests',
  'projected_month_model_cost',
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

export interface MetricDefinition {
  key: MetricKey
  label: string
  group: MetricGroup
  unit: MetricUnit
  basis: MetricBasis
  /** What the number means, in plain language. */
  description: string
  /** Exactly how it is computed and from which records. */
  method: string
  /** The rows counted (or a rate's numerator, or the rows a median is taken over). */
  evidence?: EvidenceRef
  /** For a rate or an average: the rows it is a share of. */
  denominator?: EvidenceRef
  grains: readonly Grain[]
  /** Read from usage records, which only admins and owners may read. */
  adminOnly?: boolean
}

const ALL: readonly Grain[] = GRAINS
const RUNS: readonly Grain[] = ['organization', 'workflow']
const ORG: readonly Grain[] = ['organization']

const TASKS = 'AI employee tasks created in the period'
const t = (flag: string): EvidenceRef => ({ source: 'task', flag })
const a = (flag: string): EvidenceRef => ({ source: 'action', flag })
const r = (flag: string): EvidenceRef => ({ source: 'run', flag })

export const METRICS: readonly MetricDefinition[] = [
  // --- Work ----------------------------------------------------------------------
  {
    key: 'tasks_created',
    label: 'Tasks created',
    group: 'work',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks assigned to AI employees in the period, by a person or a workflow.',
    method: `Count of ${TASKS} (tasks rows with an employee). A person’s own actions are not tasks of an AI employee and are not counted.`,
    evidence: t('created'),
    grains: ALL,
  },
  {
    key: 'tasks_completed',
    label: 'Completed by AI employees',
    group: 'work',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks the employee finished itself. Tasks a person took over and finished are counted separately.',
    method: `Count of ${TASKS} whose status is “succeeded” and that no person took over. A task only succeeds when its verification didn’t fail (the employee’s report is checked against the actions the platform recorded).`,
    evidence: t('completed'),
    grains: ALL,
  },
  {
    key: 'tasks_verified',
    label: 'Verified completions',
    group: 'work',
    unit: 'count',
    basis: 'measured',
    description: 'Completed tasks whose every verification check passed — no check needs a person’s review.',
    method: `Count of completed tasks whose stored verification status is “verified”. Completed tasks with checks that need review are not counted here.`,
    evidence: t('verified'),
    grains: ALL,
  },
  {
    key: 'verified_completion_rate',
    label: 'Verified completion rate',
    group: 'work',
    unit: 'percent',
    basis: 'calculated',
    description: 'Of the tasks that reached an end, the share an AI employee completed with every check passed.',
    method:
      'Verified completions ÷ finished tasks. Finished means succeeded, failed or cancelled (including tasks a person took over and finished); still-open tasks and tasks skipped because a task they depended on failed are left out.',
    evidence: t('verified'),
    denominator: t('finished'),
    grains: ALL,
  },
  {
    key: 'completion_rate',
    label: 'Completion rate',
    group: 'work',
    unit: 'percent',
    basis: 'calculated',
    description: 'Of the tasks that reached an end, the share an AI employee completed (verified or needing review).',
    method: 'Completed by AI employees ÷ finished tasks (as above). Task completion says nothing by itself about revenue or business results.',
    evidence: t('completed'),
    denominator: t('finished'),
    grains: ALL,
  },
  {
    key: 'tasks_open',
    label: 'Still open',
    group: 'work',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks from the period that haven’t ended yet (queued, running, waiting for approval or a reply, paused).',
    method: `Count of ${TASKS} not yet succeeded, failed, cancelled or skipped. These are left out of every rate.`,
    evidence: t('open'),
    grains: ALL,
  },
  {
    key: 'tasks_completed_by_person',
    label: 'Finished by a person',
    group: 'work',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks a person took over (human handoff) and then completed. Never credited to an AI employee.',
    method: `Count of ${TASKS} that succeeded after a person took them over.`,
    evidence: t('completed_by_person'),
    grains: ALL,
  },

  // --- Reliability ------------------------------------------------------------------
  {
    key: 'tasks_failed',
    label: 'Failed',
    group: 'reliability',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks that ended in failure, with the failure class and code the runtime recorded.',
    method: `Count of ${TASKS} whose status is “failed” (every attempt failed, a limit was hit, verification failed, or the employee couldn’t complete it).`,
    evidence: t('failed'),
    grains: ALL,
  },
  {
    key: 'tasks_cancelled',
    label: 'Cancelled',
    group: 'reliability',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks a person cancelled, or that were cancelled with their workflow run.',
    method: `Count of ${TASKS} whose status is “cancelled”.`,
    evidence: t('cancelled'),
    grains: ALL,
  },
  {
    key: 'tasks_retried',
    label: 'Tasks retried',
    group: 'reliability',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks that needed more than one attempt (a failed step, a lost server, or a person’s retry).',
    method: `Count of ${TASKS} with more than one attempt record. Waiting for an approval or a reply does not start a new attempt.`,
    evidence: t('retried'),
    grains: ALL,
  },
  {
    key: 'retries',
    label: 'Retries',
    group: 'reliability',
    unit: 'count',
    basis: 'measured',
    description: 'Attempts beyond each task’s first.',
    method: 'Sum over the period’s tasks of (attempts − 1).',
    evidence: t('retries'),
    grains: ALL,
  },
  {
    key: 'tasks_recovered',
    label: 'Recovered',
    group: 'reliability',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks that had a failed or interrupted attempt and were then completed by the employee.',
    method: 'Count of tasks with an attempt that failed or timed out, a later attempt, and a final status of succeeded without a person taking over.',
    evidence: t('recovered'),
    grains: ALL,
  },
  {
    key: 'recovery_rate',
    label: 'Recovery success',
    group: 'reliability',
    unit: 'percent',
    basis: 'calculated',
    description: 'Of the finished tasks that were retried after a failed or interrupted attempt, the share that ended completed.',
    method: 'Recovered ÷ finished tasks that had a failed or timed-out attempt followed by another attempt. Retries a person started count too (they also count as an intervention).',
    evidence: t('recovered'),
    denominator: t('recovery_attempted'),
    grains: ALL,
  },

  // --- People -----------------------------------------------------------------------
  {
    key: 'intervention_rate',
    label: 'Needed a person',
    group: 'people',
    unit: 'percent',
    basis: 'calculated',
    description: 'Share of tasks where a person had to step in: decide an approval, reply, pause, resume, retry, reassign, cancel or take over.',
    method:
      'Tasks with at least one intervention ÷ tasks created. Interventions are approvals decided by a person (approval_requests), handoffs (requested by the employee or made by a person) and the task controls a person used, read from the audit log (which retention never deletes). Priority changes are not counted.',
    evidence: t('intervened'),
    denominator: t('created'),
    grains: ALL,
  },
  {
    key: 'tasks_intervened',
    label: 'Tasks with a person’s intervention',
    group: 'people',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks where a person stepped in at least once.',
    method: 'Count of the period’s tasks with an approval decided by a person, a handoff, or a person’s task control in the audit log.',
    evidence: t('intervened'),
    grains: ALL,
  },
  {
    key: 'approvals_requested',
    label: 'Approvals asked for',
    group: 'people',
    unit: 'count',
    basis: 'measured',
    description: 'Approval requests the period’s tasks raised for consequential actions.',
    method: 'Count of approval requests linked to the period’s tasks (any status).',
    evidence: t('approvals_requested'),
    grains: ALL,
  },
  {
    key: 'approvals_approved',
    label: 'Approved',
    group: 'people',
    unit: 'count',
    basis: 'measured',
    description: 'Approval requests a person approved.',
    method: 'Count of those requests with status “approved” and a deciding person.',
    evidence: t('approvals_approved'),
    grains: ALL,
  },
  {
    key: 'approvals_rejected',
    label: 'Rejected',
    group: 'people',
    unit: 'count',
    basis: 'measured',
    description: 'Approval requests a person rejected.',
    method: 'Count of those requests with status “rejected” and a deciding person.',
    evidence: t('approvals_rejected'),
    grains: ALL,
  },
  {
    key: 'approvals_expired',
    label: 'Expired',
    group: 'people',
    unit: 'count',
    basis: 'measured',
    description: 'Approval requests nobody decided before they expired.',
    method: 'Count of those requests with status “expired”.',
    evidence: t('approvals_expired'),
    grains: ALL,
  },
  {
    key: 'handoffs',
    label: 'Handoffs',
    group: 'people',
    unit: 'count',
    basis: 'measured',
    description: 'Tasks a person took over, or the employee asked a person to take over.',
    method: 'Count of the period’s tasks with a handoff request or a person’s takeover recorded on the task.',
    evidence: t('handoff'),
    grains: ALL,
  },

  // --- Time -------------------------------------------------------------------------
  {
    key: 'completion_time_p50',
    label: 'Time to complete (median)',
    group: 'time',
    unit: 'duration',
    basis: 'calculated',
    description: 'How long a completed task took from being assigned to being completed, including time spent waiting for approvals or replies.',
    method: 'Median of (completed at − created at) over tasks completed by AI employees.',
    evidence: t('completed'),
    grains: ALL,
  },
  {
    key: 'completion_time_p90',
    label: 'Time to complete (90th percentile)',
    group: 'time',
    unit: 'duration',
    basis: 'calculated',
    description: 'Nine in ten completed tasks took this long or less.',
    method: '90th percentile (linear interpolation) of (completed at − created at) over tasks completed by AI employees.',
    evidence: t('completed'),
    grains: ALL,
  },
  {
    key: 'active_time_p50',
    label: 'Processing time (median)',
    group: 'time',
    unit: 'duration',
    basis: 'calculated',
    description: 'Time the runtime spent working on a completed task, excluding waits.',
    method: 'Median over tasks completed by AI employees of the sum of their attempts’ active time.',
    evidence: t('completed'),
    grains: ALL,
  },
  {
    key: 'response_time_p50',
    label: 'Time to first message (median)',
    group: 'time',
    unit: 'duration',
    basis: 'calculated',
    description:
      'How soon after a task was assigned the employee’s first external message was delivered. This is not the time from a customer’s own message: no inbound channel (email, chat, help desk) is connected yet.',
    method: 'Median of (finish of the first succeeded external-message action − task created at) over tasks that sent one.',
    evidence: t('responded'),
    grains: ALL,
  },

  // --- Cost of these tasks -----------------------------------------------------------
  {
    key: 'task_model_cost',
    label: 'Model cost',
    group: 'cost',
    unit: 'usd',
    basis: 'calculated',
    description: 'What the model calls of these tasks cost at the provider’s list prices. Your invoice can differ (discounts, taxes, price changes).',
    method:
      'Sum of the tasks’ attempt costs. Each model call’s cost is the input and output tokens the provider reported × the list price per token in the model catalog (src/modules/models) at the time of the call.',
    evidence: t('cost_micros'),
    grains: ALL,
  },
  {
    key: 'cost_per_completed_task',
    label: 'Model cost per completed task',
    group: 'cost',
    unit: 'usd',
    basis: 'calculated',
    description: 'Model cost of all the period’s tasks (including failed ones) divided by the tasks the employees completed.',
    method: 'Model cost ÷ completed by AI employees.',
    evidence: t('cost_micros'),
    denominator: t('completed'),
    grains: ALL,
  },
  {
    key: 'task_input_tokens',
    label: 'Input tokens',
    group: 'cost',
    unit: 'tokens',
    basis: 'measured',
    description: 'Tokens sent to the model for these tasks, as the provider reported them.',
    method: 'Sum of the attempts’ input tokens, recorded from each model response.',
    evidence: t('input_tokens'),
    grains: ALL,
  },
  {
    key: 'task_output_tokens',
    label: 'Output tokens',
    group: 'cost',
    unit: 'tokens',
    basis: 'measured',
    description: 'Tokens the model produced for these tasks, as the provider reported them.',
    method: 'Sum of the attempts’ output tokens, recorded from each model response.',
    evidence: t('output_tokens'),
    grains: ALL,
  },

  // --- Integrations -------------------------------------------------------------------
  {
    key: 'actions_requested',
    label: 'Actions requested',
    group: 'integrations',
    unit: 'count',
    basis: 'measured',
    description: 'Actions in connected apps that AI employees or workflow steps asked for in the period.',
    method: 'Count of tool executions created in the period for an AI employee’s task or a workflow step, whatever happened to them.',
    evidence: a('requested'),
    grains: ALL,
  },
  {
    key: 'actions_succeeded',
    label: 'Actions that succeeded',
    group: 'integrations',
    unit: 'count',
    basis: 'measured',
    description: 'Actions the provider carried out and answered with a valid response.',
    method: 'Count of those tool executions with status “succeeded”.',
    evidence: a('succeeded'),
    grains: ALL,
  },
  {
    key: 'actions_failed',
    label: 'Integration errors',
    group: 'integrations',
    unit: 'count',
    basis: 'measured',
    description: 'Actions that failed at or on the way to the provider, by provider and error code.',
    method: 'Count of those tool executions with status “failed”. Rejected, withdrawn or still-waiting actions are not errors.',
    evidence: a('failed'),
    grains: ALL,
  },
  {
    key: 'integration_error_rate',
    label: 'Integration error rate',
    group: 'integrations',
    unit: 'percent',
    basis: 'calculated',
    description: 'Of the actions that ran to an end, the share that failed.',
    method: 'Failed ÷ (succeeded + failed) actions.',
    evidence: a('failed'),
    denominator: a('settled'),
    grains: ALL,
  },

  // --- Workflows ----------------------------------------------------------------------
  {
    key: 'runs_started',
    label: 'Runs started',
    group: 'workflows',
    unit: 'count',
    basis: 'measured',
    description: 'Workflow runs started in the period, manually or on a schedule.',
    method: 'Count of workflow runs queued in the period.',
    evidence: r('started'),
    grains: RUNS,
  },
  {
    key: 'runs_succeeded',
    label: 'Runs succeeded',
    group: 'workflows',
    unit: 'count',
    basis: 'measured',
    description: 'Runs that reached an end step.',
    method: 'Count of those runs with status “succeeded”.',
    evidence: r('succeeded'),
    grains: RUNS,
  },
  {
    key: 'runs_failed',
    label: 'Runs failed',
    group: 'workflows',
    unit: 'count',
    basis: 'measured',
    description: 'Runs that failed or ran out of time.',
    method: 'Count of those runs with status “failed” or “timed out”. Rejected (an approval gate said no) and cancelled runs are counted apart.',
    evidence: r('failed'),
    grains: RUNS,
  },
  {
    key: 'run_success_rate',
    label: 'Run success rate',
    group: 'workflows',
    unit: 'percent',
    basis: 'calculated',
    description: 'Of the runs that ended, the share that succeeded.',
    method: 'Succeeded ÷ runs that ended (succeeded, failed, timed out, rejected or cancelled).',
    evidence: r('succeeded'),
    denominator: r('finished'),
    grains: RUNS,
  },
  {
    key: 'run_duration_p50',
    label: 'Run duration (median)',
    group: 'workflows',
    unit: 'duration',
    basis: 'calculated',
    description: 'How long a successful run took, including waits for approvals and delays.',
    method: 'Median of (finished at − started at) over succeeded runs.',
    evidence: r('succeeded'),
    grains: RUNS,
  },
  {
    key: 'run_duration_p90',
    label: 'Run duration (90th percentile)',
    group: 'workflows',
    unit: 'duration',
    basis: 'calculated',
    description: 'Nine in ten successful runs took this long or less.',
    method: '90th percentile (linear interpolation) of (finished at − started at) over succeeded runs.',
    evidence: r('succeeded'),
    grains: RUNS,
  },
  {
    key: 'runs_with_failed_step',
    label: 'Runs with a failed step',
    group: 'workflows',
    unit: 'count',
    basis: 'measured',
    description: 'Runs in which at least one step failed (the run may still have taken a failure path to an end).',
    method: 'Count of runs with at least one run step whose status is “failed”.',
    evidence: r('has_failed_step'),
    grains: RUNS,
  },
  {
    key: 'run_model_cost',
    label: 'Model cost of runs',
    group: 'workflows',
    unit: 'usd',
    basis: 'calculated',
    description: 'Model cost of the employee tasks inside these runs, at list prices.',
    method: 'Sum of the attempt costs of the runs’ tasks (see “Model cost”).',
    evidence: r('cost_micros'),
    grains: RUNS,
  },

  // --- All model usage (admins) ------------------------------------------------------------
  {
    key: 'model_cost_total',
    label: 'Model spend in the period',
    group: 'usage',
    unit: 'usd',
    basis: 'calculated',
    description: 'Every model call the workspace made in the period: tasks and test runs. At list prices.',
    method: 'Sum of the model cost usage records written in the period (one per model call, at list prices). Only admins and owners can read usage records.',
    grains: ORG,
    adminOnly: true,
  },
  {
    key: 'model_cost_tests',
    label: 'Of which test runs',
    group: 'usage',
    unit: 'usd',
    basis: 'calculated',
    description: 'The part of the spend that came from playground and test-case runs, which never act on anything.',
    method: 'Sum of the period’s model cost usage records written by test runs.',
    grains: ORG,
    adminOnly: true,
  },
  {
    key: 'projected_month_model_cost',
    label: 'Projected month-end model spend',
    group: 'usage',
    unit: 'usd',
    basis: 'estimate',
    description: 'Where this month’s spend would end up if the rest of the month looked like the days so far.',
    method:
      'Month-to-date spend ÷ days elapsed this month (UTC) × days in the month. Assumes usage continues at the same average daily rate; new employees, workflows or busy days make it wrong. Not shown in the first three days of a month.',
    grains: ORG,
    adminOnly: true,
  },
]

const BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]))

export function getMetric(key: MetricKey): MetricDefinition {
  const metric = BY_KEY.get(key)
  if (!metric) throw new Error(`Unknown metric ${key}`)
  return metric
}

export function metricsForGroup(group: MetricGroup, grain: Grain): MetricDefinition[] {
  return METRICS.filter((metric) => metric.group === group && metric.grains.includes(grain))
}

/** What analytics deliberately doesn't report, and why (shown on the definitions page). */
export const NOT_REPORTED: readonly { label: string; reason: string }[] = [
  {
    label: 'Hours saved',
    reason:
      'Nothing records how long a person would have taken to do the same work, so any figure would be invented. Processing time and time to complete are measured; time saved is not.',
  },
  {
    label: 'Revenue or deals won',
    reason:
      'Completing a task is not revenue. No connected app reports deals or payments to Nexefiy yet, and a lead marked qualified is a CRM change, not a sale.',
  },
  {
    label: 'Appointments booked',
    reason: 'Needs a calendar integration, which isn’t built yet.',
  },
  {
    label: 'Tickets resolved',
    reason: 'Needs a help desk integration, which isn’t built yet.',
  },
  {
    label: 'Response time to customers',
    reason: 'Needs an inbound channel (email, chat or help desk), which isn’t connected yet. Time to first message is measured from task assignment instead.',
  },
]

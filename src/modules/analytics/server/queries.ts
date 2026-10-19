// Reads for the analytics pages, under the signed-in user's session. The SQL
// functions check membership (and admin for model usage) and scope every
// query to the organization; nothing here uses the service role.

import 'server-only'

import { createUserClient } from '@/lib/supabase/server'
import { DEPARTMENT_LABELS, DEPARTMENTS, type Department } from '@/modules/employees/domain/types'

import {
  projectMonthEnd,
  summarizeUsage,
  type ActionMetricsRow,
  type FailureRow,
  type ModelUsageRow,
  type OutcomeMetricsRow,
  type Projection,
  type TaskMetricsRow,
  type UsageSummary,
  type WorkflowMetricsRow,
} from '../domain/calculations'
import { EVIDENCE_PAGE_SIZE, type EvidenceQuery } from '../domain/evidence'
import type { AnalyticsPeriod } from '../domain/period'

function fail(what: string, code: string | undefined): never {
  throw new Error(`Couldn’t load ${what} (${code ?? 'unknown'}).`)
}

const TEXT_FIELDS = new Set(['grain', 'key', 'error_code', 'failure_class', 'failure_code', 'outcome_key', 'source', 'model'])

/** Counts and sums arrive as JSON numbers, or as strings when a driver keeps bigint exact; keep numbers. */
function numbers<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[key] = typeof value === 'string' && !TEXT_FIELDS.has(key) && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value
  return out as T
}

export interface AnalyticsReport {
  period: AnalyticsPeriod
  tasks: TaskMetricsRow[]
  actions: ActionMetricsRow[]
  runs: WorkflowMetricsRow[]
  outcomes: OutcomeMetricsRow[]
  failures: FailureRow[]
  /** Null for members below admin, who can't read usage records. */
  usage: { summary: UsageSummary; projection: Projection } | null
}

export async function loadAnalytics(
  organizationId: string,
  period: AnalyticsPeriod,
  options: { includeUsage: boolean; now: Date },
): Promise<AnalyticsReport> {
  const supabase = await createUserClient()
  const args = { p_organization_id: organizationId, p_from: period.from.toISOString(), p_to: period.to.toISOString() }
  const monthStart = new Date(Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), 1))
  const [tasks, actions, runs, outcomes, failures, usage, monthUsage] = await Promise.all([
    supabase.rpc('analytics_task_metrics', args),
    supabase.rpc('analytics_action_metrics', args),
    supabase.rpc('analytics_workflow_metrics', args),
    supabase.rpc('analytics_outcome_metrics', args),
    supabase.rpc('analytics_task_failures', args),
    options.includeUsage ? supabase.rpc('analytics_model_usage', args) : null,
    options.includeUsage
      ? supabase.rpc('analytics_model_usage', { p_organization_id: organizationId, p_from: monthStart.toISOString(), p_to: options.now.toISOString() })
      : null,
  ])
  if (tasks.error) fail('task metrics', tasks.error.code)
  if (actions.error) fail('action metrics', actions.error.code)
  if (runs.error) fail('workflow metrics', runs.error.code)
  if (outcomes.error) fail('outcome metrics', outcomes.error.code)
  if (failures.error) fail('failure breakdown', failures.error.code)
  if (usage?.error) fail('model usage', usage.error.code)
  if (monthUsage?.error) fail('month-to-date model usage', monthUsage.error.code)

  return {
    period,
    tasks: tasks.data.map((row) => numbers(row) as TaskMetricsRow),
    actions: actions.data.map((row) => numbers(row) as ActionMetricsRow),
    runs: runs.data.map((row) => numbers(row) as WorkflowMetricsRow),
    outcomes: outcomes.data.map((row) => numbers(row) as OutcomeMetricsRow),
    failures: failures.data.map((row) => numbers(row) as FailureRow),
    usage:
      usage && monthUsage
        ? {
            summary: summarizeUsage(usage.data.map((row) => numbers(row) as ModelUsageRow)),
            projection: projectMonthEnd(summarizeUsage(monthUsage.data.map((row) => numbers(row) as ModelUsageRow)).totalMicros, options.now),
          }
        : null,
  }
}

export interface ScopeNames {
  employees: Map<string, { name: string; department: Department | null }>
  workflows: Map<string, string>
}

function isDepartment(value: unknown): value is Department {
  return typeof value === 'string' && (DEPARTMENTS as readonly string[]).includes(value)
}

/** Names of the workspace's employees (with their current department) and workflows. */
export async function loadScopeNames(organizationId: string): Promise<ScopeNames> {
  const supabase = await createUserClient()
  const [employees, workflows] = await Promise.all([
    supabase
      .from('ai_employees')
      .select('id, name, current:employee_versions!ai_employees_current_version_fk(config)')
      .eq('organization_id', organizationId)
      .order('name')
      .limit(1000),
    supabase.from('workflow_definitions').select('id, name').eq('organization_id', organizationId).order('name').limit(1000),
  ])
  if (employees.error) fail('the employees', employees.error.code)
  if (workflows.error) fail('the workflows', workflows.error.code)
  return {
    employees: new Map(
      employees.data.map((row) => {
        const config = (row.current as { config?: { profile?: { department?: unknown } } } | null)?.config
        const department = config?.profile?.department
        return [row.id, { name: row.name, department: isDepartment(department) ? department : null }]
      }),
    ),
    workflows: new Map(workflows.data.map((row) => [row.id, row.name])),
  }
}

export function departmentLabel(key: string): string {
  return isDepartment(key) ? DEPARTMENT_LABELS[key] : key === 'unspecified' ? 'No department set' : key
}

export interface IntegrationHealth {
  id: string
  provider: string
  name: string
  status: string
  health: string
  checkedAt: string | null
  message: string | null
}

/** The connections as they are now (not for a period). */
export async function loadIntegrationHealth(organizationId: string): Promise<IntegrationHealth[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('integrations')
    .select('id, provider, display_name, status, health_status, last_health_check_at, health_message')
    .eq('organization_id', organizationId)
    .order('provider')
  if (error) fail('the integrations', error.code)
  return data.map((row) => ({
    id: row.id,
    provider: row.provider,
    name: row.display_name,
    status: row.status,
    health: row.health_status,
    checkedAt: row.last_health_check_at,
    message: row.health_message,
  }))
}

export interface EvidencePage {
  items: Record<string, unknown>[]
  total: number
  pageSize: number
}

export async function loadEvidence(organizationId: string, query: EvidenceQuery): Promise<EvidencePage> {
  const supabase = await createUserClient()
  const page = query.page ?? 1
  const { data, error } = await supabase.rpc('analytics_evidence', {
    p_organization_id: organizationId,
    p_from: query.period.from.toISOString(),
    p_to: query.period.to.toISOString(),
    p_source: query.source,
    p_flag: query.flag,
    p_grain: query.grain,
    p_key: query.key,
    p_limit: EVIDENCE_PAGE_SIZE,
    p_offset: (page - 1) * EVIDENCE_PAGE_SIZE,
  })
  if (error) fail('the evidence', error.code)
  return {
    items: data.map((row) => (row.item ?? {}) as Record<string, unknown>),
    total: Number(data[0]?.total ?? 0),
    pageSize: EVIDENCE_PAGE_SIZE,
  }
}

// Read models for the Task Center, loaded with the user's session so RLS
// limits them to workspaces the user belongs to (and every query also filters
// by the active organization). The checkpoint (raw model conversation) is not
// readable by clients; the history is the task's execution events, actions,
// approvals, evidence and attempts.

import 'server-only'

import type { ListState } from '@/lib/list-params'
import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'
import { escapeLikePattern } from '@/modules/governance/domain/approvals'
import type { TaskReport, Verification } from '@/modules/tasks/domain/verification'

import type { FailureClass, TaskFailure } from '../domain/failures'
import { TASK_STATUSES, type TaskStatus } from '../domain/labels'
import { periodStart, type TaskFilterParam, type TaskPeriod, type TaskSortColumn } from '../domain/task-center'

export class TaskDataError extends Error {
  override name = 'TaskDataError'
}

function fail(what: string, error: { code?: string }): never {
  console.error(`[tasks] loading ${what} failed`, redact({ code: error.code }))
  throw new TaskDataError(`We couldn’t load ${what}. Please try again.`)
}

function asStatus(value: string): TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : 'pending'
}

/** Wall-clock time from start to finish (or to now while unfinished). */
function elapsedMs(startedAt: string | null, completedAt: string | null, now: Date): number | null {
  if (!startedAt) return null
  return Math.max(0, (completedAt ? new Date(completedAt) : now).getTime() - new Date(startedAt).getTime())
}

export interface TaskListItem {
  id: string
  title: string
  status: TaskStatus
  priority: number
  employeeId: string | null
  employeeName: string | null
  workflowId: string | null
  workflowName: string | null
  source: string
  createdAt: string
  completedAt: string | null
  deadlineAt: string | null
  durationMs: number | null
  costMicros: number
  failure: { class: FailureClass; code: string } | null
  verification: Verification['status'] | null
}

export interface TaskListFilters {
  employeeId?: string | null
  workflowId?: string | null
}

const LIST_COLUMNS = 'id, title, status, priority, employee_id, workflow_run_id, source, created_at, started_at, completed_at, deadline_at, result, error'

/**
 * The Task Center list: employee tasks and workflow tasks (not the
 * single-action tasks the executor creates for a person's own action).
 */
export async function listTasks(
  organizationId: string,
  list: ListState<TaskSortColumn, TaskFilterParam>,
  filters: TaskListFilters = {},
  now = new Date(),
): Promise<{ items: TaskListItem[]; total: number }> {
  const supabase = await createUserClient()

  let runIds: string[] | null = null
  if (filters.workflowId) {
    const { data, error } = await supabase.from('workflow_runs').select('id').eq('organization_id', organizationId).eq('workflow_id', filters.workflowId).limit(1000)
    if (error) fail('workflow runs', error)
    runIds = (data ?? []).map((row) => row.id)
    if (!runIds.length) return { items: [], total: 0 }
  }

  let query = supabase.from('tasks').select(LIST_COLUMNS, { count: 'exact' }).eq('organization_id', organizationId).or('employee_id.not.is.null,workflow_run_id.not.is.null')
  if (list.filters.status) query = query.eq('status', list.filters.status)
  if (list.filters.failure) query = query.eq('error->>class', list.filters.failure)
  if (list.filters.period) query = query.gte('created_at', periodStart(list.filters.period as TaskPeriod, now).toISOString())
  if (filters.employeeId) query = query.eq('employee_id', filters.employeeId)
  if (runIds) query = query.in('workflow_run_id', runIds)
  if (list.q) query = query.ilike('title', `%${escapeLikePattern(list.q)}%`)

  const { data, count, error } = await query
    .order(list.sort.column, { ascending: list.sort.direction === 'asc', nullsFirst: false })
    .order('id')
    .range(list.from, list.to)
  if (error) fail('tasks', error)
  const rows = data ?? []
  return { items: await decorate(supabase, organizationId, rows, now), total: count ?? rows.length }
}

/** The most recent tasks of one employee (its page). */
export async function listEmployeeTasks(organizationId: string, employeeId: string, limit = 10): Promise<TaskListItem[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('tasks')
    .select(LIST_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) fail('tasks', error)
  return decorate(supabase, organizationId, data ?? [], new Date())
}

type ListRow = {
  id: string
  title: string
  status: string
  priority: number
  employee_id: string | null
  workflow_run_id: string | null
  source: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  deadline_at: string | null
  result: unknown
  error: unknown
}

async function decorate(supabase: Awaited<ReturnType<typeof createUserClient>>, organizationId: string, rows: ListRow[], now: Date): Promise<TaskListItem[]> {
  const employeeIds = [...new Set(rows.map((row) => row.employee_id).filter((id): id is string => Boolean(id)))]
  const runIds = [...new Set(rows.map((row) => row.workflow_run_id).filter((id): id is string => Boolean(id)))]
  const taskIds = rows.map((row) => row.id)

  const [employees, runs, attempts] = await Promise.all([
    employeeIds.length ? supabase.from('ai_employees').select('id, name').eq('organization_id', organizationId).in('id', employeeIds) : Promise.resolve({ data: [], error: null }),
    runIds.length ? supabase.from('workflow_runs').select('id, workflow_id').eq('organization_id', organizationId).in('id', runIds) : Promise.resolve({ data: [], error: null }),
    taskIds.length ? supabase.from('task_attempts').select('task_id, cost_micros').eq('organization_id', organizationId).in('task_id', taskIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (employees.error) fail('employees', employees.error)
  if (runs.error) fail('workflow runs', runs.error)
  if (attempts.error) fail('attempts', attempts.error)

  const workflowIds = [...new Set((runs.data ?? []).map((row) => row.workflow_id))]
  const workflows = workflowIds.length
    ? await supabase.from('workflow_definitions').select('id, name').eq('organization_id', organizationId).in('id', workflowIds)
    : { data: [], error: null }
  if (workflows.error) fail('workflows', workflows.error)

  const employeeNames = new Map((employees.data ?? []).map((row) => [row.id, row.name]))
  const runWorkflow = new Map((runs.data ?? []).map((row) => [row.id, row.workflow_id]))
  const workflowNames = new Map((workflows.data ?? []).map((row) => [row.id, row.name]))
  const cost = new Map<string, number>()
  for (const row of attempts.data ?? []) cost.set(row.task_id, (cost.get(row.task_id) ?? 0) + Number(row.cost_micros ?? 0))

  return rows.map((row) => {
    const workflowId = row.workflow_run_id ? (runWorkflow.get(row.workflow_run_id) ?? null) : null
    const error = (row.error ?? null) as TaskFailure | null
    return {
      id: row.id,
      title: row.title,
      status: asStatus(row.status),
      priority: row.priority,
      employeeId: row.employee_id,
      employeeName: row.employee_id ? (employeeNames.get(row.employee_id) ?? null) : null,
      workflowId,
      workflowName: workflowId ? (workflowNames.get(workflowId) ?? null) : null,
      source: row.source,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      deadlineAt: row.deadline_at,
      durationMs: elapsedMs(row.started_at, row.completed_at, now),
      costMicros: cost.get(row.id) ?? 0,
      failure: error?.class ? { class: error.class, code: error.code } : null,
      verification: ((row.result ?? null) as { verification?: Verification } | null)?.verification?.status ?? null,
    }
  })
}

export interface TaskFilterOptions {
  employees: { id: string; name: string; status: string }[]
  workflows: { id: string; name: string }[]
}

export async function listTaskFilterOptions(organizationId: string): Promise<TaskFilterOptions> {
  const supabase = await createUserClient()
  const [employees, workflows] = await Promise.all([
    supabase.from('ai_employees').select('id, name, status').eq('organization_id', organizationId).neq('status', 'archived').order('name').limit(200),
    supabase.from('workflow_definitions').select('id, name').eq('organization_id', organizationId).order('name').limit(200),
  ])
  if (employees.error) fail('employees', employees.error)
  if (workflows.error) fail('workflows', workflows.error)
  return { employees: employees.data ?? [], workflows: workflows.data ?? [] }
}

/** Unfinished tasks a new task can depend on. */
export async function listDependableTasks(organizationId: string, limit = 30): Promise<{ id: string; title: string; status: TaskStatus }[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, status')
    .eq('organization_id', organizationId)
    .not('employee_id', 'is', null)
    .is('workflow_run_id', null)
    .in('status', ['pending', 'queued', 'running', 'waiting_approval', 'blocked', 'paused'])
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) fail('tasks', error)
  return (data ?? []).map((row) => ({ id: row.id, title: row.title, status: asStatus(row.status) }))
}

export interface TaskEvent {
  id: number
  type: string
  level: string
  message: string | null
  data: Record<string, unknown>
  createdAt: string
}

export interface TaskAction {
  id: string
  toolKey: string
  risk: string
  status: string
  decision: string
  reason: string | null
  input: Record<string, unknown>
  output: unknown
  error: { code?: string; message?: string } | null
  approvalRequestId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface TaskApproval {
  id: string
  toolExecutionId: string | null
  summary: string
  status: string
  requiredRole: string
  createdAt: string
  expiresAt: string
  decidedAt: string | null
  note: string | null
}

export interface TaskEvidenceItem {
  id: string
  kind: string
  label: string | null
  title: string
  excerpt: string | null
  toolKey: string | null
  executionId: string | null
  suspicious: boolean
  createdAt: string
}

export interface TaskAttemptItem {
  number: number
  status: string
  model: string | null
  turns: number
  toolCalls: number
  costMicros: number
  inputTokens: number
  outputTokens: number
  activeMs: number
  error: TaskFailure | null
  startedAt: string
  finishedAt: string | null
}

export interface TaskResultView {
  outcome?: string
  reply?: string
  report?: TaskReport | null
  verification?: Verification
  escalation?: { reason: string; message: string } | null
  costMicros?: number
}

export interface TaskLink {
  id: string
  title: string
  status: TaskStatus
}

export interface TaskDetail {
  id: string
  title: string
  instructions: string | null
  status: TaskStatus
  priority: number
  source: string
  employeeId: string | null
  employeeName: string | null
  employeeVersion: number | null
  workflow: { id: string; name: string; version: number | null; runId: string; runStatus: string } | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  deadlineAt: string | null
  pausedAt: string | null
  cancelRequested: boolean
  pauseRequested: boolean
  /** The employee escalated and a person is needed. */
  handoffRequestedAt: string | null
  /** A person took the task over (it never returns to the employee). */
  handoff: { to: string | null; by: string | null; at: string; note: string | null } | null
  /** Paused by the workspace's emergency stop. */
  emergencyPaused: boolean
  attemptCount: number
  maxAttempts: number
  result: TaskResultView | null
  error: TaskFailure | null
  durationMs: number | null
  activeMs: number
  costMicros: number
  inputTokens: number
  outputTokens: number
  dependsOn: TaskLink[]
  dependents: TaskLink[]
  events: TaskEvent[]
  actions: TaskAction[]
  approvals: TaskApproval[]
  evidence: TaskEvidenceItem[]
  attempts: TaskAttemptItem[]
}

export async function getTask(organizationId: string, taskId: string, now = new Date()): Promise<TaskDetail | null> {
  const supabase = await createUserClient()
  const { data: task, error } = await supabase
    .from('tasks')
    .select(
      'id, title, instructions, status, priority, source, employee_id, employee_version_id, workflow_run_id, created_at, started_at, completed_at, deadline_at, paused_at, cancel_requested_at, pause_requested_at, attempt_count, max_attempts, result, error, handoff_requested_at, handed_off_to, handed_off_by, handed_off_at, handoff_note, emergency_paused_at',
    )
    .eq('id', taskId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) fail('the task', error)
  if (!task || (!task.employee_id && !task.workflow_run_id)) return null

  const none = Promise.resolve({ data: null, error: null })
  const [employee, version, run, events, executions, approvals, evidence, attempts, upstream, downstream] = await Promise.all([
    task.employee_id ? supabase.from('ai_employees').select('name').eq('id', task.employee_id).eq('organization_id', organizationId).maybeSingle() : none,
    task.employee_version_id ? supabase.from('employee_versions').select('version').eq('id', task.employee_version_id).eq('organization_id', organizationId).maybeSingle() : none,
    task.workflow_run_id
      ? supabase.from('workflow_runs').select('id, workflow_id, workflow_version_id, status').eq('id', task.workflow_run_id).eq('organization_id', organizationId).maybeSingle()
      : none,
    supabase.from('execution_events').select('id, event_type, level, message, data, created_at').eq('task_id', taskId).eq('organization_id', organizationId).order('id').limit(500),
    supabase
      .from('tool_executions')
      .select('id, tool_key, risk_level, status, policy_decision, policy_reason, input_redacted, output_redacted, error, created_at, started_at, finished_at')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('created_at'),
    supabase
      .from('approval_requests')
      .select('id, tool_execution_id, action_summary, status, required_role, created_at, expires_at, decided_at, decision_note')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('created_at'),
    supabase
      .from('task_evidence')
      .select('id, kind, label, title, excerpt, tool_key, tool_execution_id, suspected_instructions, created_at')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('created_at')
      .limit(200),
    supabase
      .from('task_attempts')
      .select('attempt_number, status, model, turn_count, tool_call_count, cost_micros, model_input_tokens, model_output_tokens, active_ms, error, started_at, finished_at')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('attempt_number'),
    supabase.from('task_dependencies').select('depends_on_task_id').eq('task_id', taskId).eq('organization_id', organizationId),
    supabase.from('task_dependencies').select('task_id').eq('depends_on_task_id', taskId).eq('organization_id', organizationId),
  ])
  for (const [what, result] of [
    ['the employee', employee],
    ['the version', version],
    ['the workflow run', run],
    ['the task’s events', events],
    ['the task’s actions', executions],
    ['approvals', approvals],
    ['evidence', evidence],
    ['attempts', attempts],
    ['dependencies', upstream],
    ['dependents', downstream],
  ] as const) {
    if (result.error) fail(what, result.error)
  }

  const linkIds = [...(upstream.data ?? []).map((row) => row.depends_on_task_id), ...(downstream.data ?? []).map((row) => row.task_id)]
  const [links, workflow, workflowVersion] = await Promise.all([
    linkIds.length ? supabase.from('tasks').select('id, title, status').eq('organization_id', organizationId).in('id', linkIds) : Promise.resolve({ data: [], error: null }),
    run.data ? supabase.from('workflow_definitions').select('id, name').eq('id', run.data.workflow_id).eq('organization_id', organizationId).maybeSingle() : none,
    run.data ? supabase.from('workflow_versions').select('version').eq('id', run.data.workflow_version_id).eq('organization_id', organizationId).maybeSingle() : none,
  ])
  if (links.error) fail('related tasks', links.error)
  if (workflow.error) fail('the workflow', workflow.error)
  if (workflowVersion.error) fail('the workflow version', workflowVersion.error)
  const linkById = new Map((links.data ?? []).map((row) => [row.id, { id: row.id, title: row.title, status: asStatus(row.status) }]))

  const approvalByExecution = new Map((approvals.data ?? []).map((row) => [row.tool_execution_id, row.id]))
  const attemptItems: TaskAttemptItem[] = (attempts.data ?? []).map((row) => ({
    number: row.attempt_number,
    status: row.status,
    model: row.model,
    turns: row.turn_count,
    toolCalls: row.tool_call_count,
    costMicros: Number(row.cost_micros),
    inputTokens: Number(row.model_input_tokens),
    outputTokens: Number(row.model_output_tokens),
    activeMs: Number(row.active_ms),
    error: (row.error ?? null) as TaskFailure | null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }))

  return {
    id: task.id,
    title: task.title,
    instructions: task.instructions,
    status: asStatus(task.status),
    priority: task.priority,
    source: task.source,
    employeeId: task.employee_id,
    employeeName: employee.data?.name ?? null,
    employeeVersion: version.data?.version ?? null,
    workflow: run.data
      ? { id: run.data.workflow_id, name: workflow.data?.name ?? 'Workflow', version: workflowVersion.data?.version ?? null, runId: run.data.id, runStatus: run.data.status }
      : null,
    createdAt: task.created_at,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    deadlineAt: task.deadline_at,
    pausedAt: task.paused_at,
    cancelRequested: Boolean(task.cancel_requested_at),
    pauseRequested: Boolean(task.pause_requested_at),
    handoffRequestedAt: task.handoff_requested_at,
    handoff: task.handed_off_at ? { to: task.handed_off_to, by: task.handed_off_by, at: task.handed_off_at, note: task.handoff_note } : null,
    emergencyPaused: Boolean(task.emergency_paused_at),
    attemptCount: task.attempt_count,
    maxAttempts: task.max_attempts,
    result: (task.result ?? null) as TaskResultView | null,
    error: (task.error ?? null) as TaskFailure | null,
    durationMs: elapsedMs(task.started_at, task.completed_at, now),
    activeMs: attemptItems.reduce((sum, attempt) => sum + attempt.activeMs, 0),
    costMicros: attemptItems.reduce((sum, attempt) => sum + attempt.costMicros, 0),
    inputTokens: attemptItems.reduce((sum, attempt) => sum + attempt.inputTokens, 0),
    outputTokens: attemptItems.reduce((sum, attempt) => sum + attempt.outputTokens, 0),
    dependsOn: (upstream.data ?? []).flatMap((row) => linkById.get(row.depends_on_task_id) ?? []),
    dependents: (downstream.data ?? []).flatMap((row) => linkById.get(row.task_id) ?? []),
    events: (events.data ?? []).map((row) => ({
      id: row.id,
      type: row.event_type,
      level: row.level,
      message: row.message,
      data: (row.data ?? {}) as Record<string, unknown>,
      createdAt: row.created_at,
    })),
    actions: (executions.data ?? []).map((row) => ({
      id: row.id,
      toolKey: row.tool_key,
      risk: row.risk_level,
      status: row.status,
      decision: row.policy_decision,
      reason: row.policy_reason,
      input: (row.input_redacted ?? {}) as Record<string, unknown>,
      output: row.output_redacted,
      error: (row.error ?? null) as TaskAction['error'],
      approvalRequestId: approvalByExecution.get(row.id) ?? null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
    approvals: (approvals.data ?? []).map((row) => ({
      id: row.id,
      toolExecutionId: row.tool_execution_id,
      summary: row.action_summary,
      status: row.status,
      requiredRole: row.required_role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      note: row.decision_note,
    })),
    evidence: (evidence.data ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      title: row.title,
      excerpt: row.excerpt,
      toolKey: row.tool_key,
      executionId: row.tool_execution_id,
      suspicious: row.suspected_instructions,
      createdAt: row.created_at,
    })),
    attempts: attemptItems,
  }
}

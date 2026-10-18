// Read models for the task pages, loaded with the user's session so RLS
// limits them to workspaces the user belongs to (and every query also filters
// by the active organization). The checkpoint (raw model conversation) is not
// readable by clients; the trace is the task's execution events, evidence and
// tool executions.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'
import type { TaskReport, Verification } from '@/modules/tasks/domain/verification'

import type { TaskFailure } from '../domain/failures'
import { TASK_STATUSES, type TaskStatus } from '../domain/labels'

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

export interface TaskListItem {
  id: string
  title: string
  status: TaskStatus
  employeeId: string | null
  employeeName: string | null
  source: string
  createdAt: string
  completedAt: string | null
  verification: Verification['status'] | null
}

export async function listTasks(organizationId: string, options: { employeeId?: string; limit?: number } = {}): Promise<TaskListItem[]> {
  const supabase = await createUserClient()
  let query = supabase
    .from('tasks')
    .select('id, title, status, employee_id, source, created_at, completed_at, result')
    .eq('organization_id', organizationId)
    .not('employee_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 50)
  if (options.employeeId) query = query.eq('employee_id', options.employeeId)
  const { data, error } = await query
  if (error) fail('tasks', error)

  const employeeIds = [...new Set((data ?? []).map((row) => row.employee_id).filter((id): id is string => Boolean(id)))]
  const names = new Map<string, string>()
  if (employeeIds.length) {
    const { data: employees, error: employeesError } = await supabase.from('ai_employees').select('id, name').eq('organization_id', organizationId).in('id', employeeIds)
    if (employeesError) fail('employees', employeesError)
    for (const employee of employees ?? []) names.set(employee.id, employee.name)
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: asStatus(row.status),
    employeeId: row.employee_id,
    employeeName: row.employee_id ? (names.get(row.employee_id) ?? null) : null,
    source: row.source,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    verification: ((row.result ?? null) as { verification?: Verification } | null)?.verification?.status ?? null,
  }))
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
  finishedAt: string | null
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

export interface TaskDetail {
  id: string
  title: string
  instructions: string | null
  status: TaskStatus
  employeeId: string | null
  employeeName: string | null
  employeeVersion: number | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  cancelRequested: boolean
  attemptCount: number
  maxAttempts: number
  result: TaskResultView | null
  error: TaskFailure | null
  events: TaskEvent[]
  actions: TaskAction[]
  evidence: TaskEvidenceItem[]
  attempts: TaskAttemptItem[]
}

export async function getTask(organizationId: string, taskId: string): Promise<TaskDetail | null> {
  const supabase = await createUserClient()
  const { data: task, error } = await supabase
    .from('tasks')
    .select('id, title, instructions, status, employee_id, employee_version_id, created_at, started_at, completed_at, cancel_requested_at, attempt_count, max_attempts, result, error')
    .eq('id', taskId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) fail('the task', error)
  if (!task || !task.employee_id) return null

  const [employee, version, events, executions, approvals, evidence, attempts] = await Promise.all([
    supabase.from('ai_employees').select('name').eq('id', task.employee_id).eq('organization_id', organizationId).maybeSingle(),
    task.employee_version_id
      ? supabase.from('employee_versions').select('version').eq('id', task.employee_version_id).eq('organization_id', organizationId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from('execution_events').select('id, event_type, level, message, data, created_at').eq('task_id', taskId).eq('organization_id', organizationId).order('id').limit(500),
    supabase
      .from('tool_executions')
      .select('id, tool_key, risk_level, status, policy_decision, policy_reason, input_redacted, output_redacted, error, created_at, finished_at')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('created_at'),
    supabase.from('approval_requests').select('id, tool_execution_id').eq('task_id', taskId).eq('organization_id', organizationId),
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
  ])
  for (const [what, result] of [
    ['the employee', employee],
    ['the version', version],
    ['the task’s events', events],
    ['the task’s actions', executions],
    ['approvals', approvals],
    ['evidence', evidence],
    ['attempts', attempts],
  ] as const) {
    if (result.error) fail(what, result.error)
  }

  const approvalByExecution = new Map((approvals.data ?? []).map((row) => [row.tool_execution_id, row.id]))
  return {
    id: task.id,
    title: task.title,
    instructions: task.instructions,
    status: asStatus(task.status),
    employeeId: task.employee_id,
    employeeName: employee.data?.name ?? null,
    employeeVersion: version.data?.version ?? null,
    createdAt: task.created_at,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    cancelRequested: Boolean(task.cancel_requested_at),
    attemptCount: task.attempt_count,
    maxAttempts: task.max_attempts,
    result: (task.result ?? null) as TaskResultView | null,
    error: (task.error ?? null) as TaskFailure | null,
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
      finishedAt: row.finished_at,
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
    attempts: (attempts.data ?? []).map((row) => ({
      number: row.attempt_number,
      status: row.status,
      model: row.model,
      turns: row.turn_count,
      toolCalls: row.tool_call_count,
      costMicros: row.cost_micros,
      inputTokens: row.model_input_tokens,
      outputTokens: row.model_output_tokens,
      activeMs: row.active_ms,
      error: (row.error ?? null) as TaskFailure | null,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
  }
}

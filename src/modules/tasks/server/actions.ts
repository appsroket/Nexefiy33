'use server'

// Server Actions for employee tasks: assigning (priority, dependencies,
// deadline), cancelling, pausing, resuming, retrying, changing priority,
// reassigning, and replying to an escalation. Each runs under the user's own
// session through a SQL function that checks the role, the organization and
// the task's state; the work itself runs in the execution engine (or, without
// one, after the response and from the cron route).

import { randomUUID } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { redact } from '@/lib/logging/redact'
import { createRateLimiter } from '@/lib/rate-limit'
import { createUserClient } from '@/lib/supabase/server'
import { getVerifiedUser, SESSION_ENDED_MESSAGE } from '@/modules/identity/server/session'

import { cancellationDisclosure, DEFAULT_TIMEOUT_MINUTES } from '../domain/task-center'
import { canRunTasks, scheduleTaskProcessing } from './scheduling'

const assignLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 })

const assignSchema = z.object({
  employeeId: z.uuid(),
  title: z.string().trim().min(1, 'Describe the task.').max(200, 'Keep the title under 200 characters.'),
  instructions: z
    .string()
    .trim()
    .max(20_000, 'The details are too long.')
    .optional()
    .transform((value) => value || null),
  // Generated when the form renders, so a double submit creates one task.
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional(),
  priority: z.coerce.number().int().min(-100).max(100).default(0),
  timeoutMinutes: z.coerce.number().int().min(5).max(43_200).default(DEFAULT_TIMEOUT_MINUTES),
  dependsOn: z.array(z.uuid()).max(20, 'A task can depend on up to 20 tasks.').default([]),
})

const ASSIGN_ERRORS: Record<string, string> = {
  P0002: 'That employee or a task it depends on doesn’t exist in this workspace, or your role can’t assign tasks.',
  '55000': 'Only an active employee can be given tasks, and only after tasks it depends on that haven’t failed or been cancelled.',
  '22023': 'Check the task’s title and details.',
  '23514': 'The task contains something that looks like a password, token or API key. Remove it and try again.',
}

export async function assignTask(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = assignSchema.safeParse({ ...Object.fromEntries(formData), dependsOn: formData.getAll('dependsOn') })
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors
    return actionError('Check the task and try again.', fieldErrors)
  }
  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  if (!user) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')
  if (!assignLimiter(user.id)) return actionError('You’ve assigned many tasks in a short time. Wait a minute and try again.')

  const { data, error } = await supabase.rpc('assign_employee_task', {
    p_employee_id: parsed.data.employeeId,
    p_title: parsed.data.title,
    p_instructions: parsed.data.instructions ?? '',
    p_idempotency_key: parsed.data.requestKey ?? randomUUID(),
    p_priority: parsed.data.priority,
    p_depends_on: parsed.data.dependsOn,
    p_timeout_minutes: parsed.data.timeoutMinutes,
  })
  if (error || !data) {
    const message = (error?.code && ASSIGN_ERRORS[error.code]) ?? null
    if (!message) console.error('[tasks] assigning a task failed', redact({ code: error?.code }))
    return actionError(message ?? 'The task couldn’t be assigned. Please try again.')
  }

  scheduleTaskProcessing({ reason: 'assigned' })
  revalidatePath('/app/tasks')
  revalidatePath(`/app/employees/${parsed.data.employeeId}`)
  redirect(`/app/tasks/${data}${canRunTasks() ? '' : '?unavailable=1'}`)
}

const taskIdSchema = z.uuid()

const STATE_ERRORS: Record<string, string> = {
  P0002: 'That task doesn’t exist, or your role can’t change it.',
  '55000': 'The task’s state changed. Refresh the page to see what it’s doing now.',
  '22023': 'That value isn’t allowed.',
}

type ControlRpc = 'pause_employee_task' | 'resume_employee_task' | 'retry_employee_task'

async function control(taskId: string, rpc: ControlRpc | 'cancel_employee_task', what: string) {
  const id = taskIdSchema.safeParse(taskId)
  if (!id.success) return { error: actionError('That task doesn’t exist.') }
  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return { error: actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended') }
  const { data, error } = await supabase.rpc(rpc, { p_task_id: id.data })
  if (error) {
    const message = (error.code && STATE_ERRORS[error.code]) ?? null
    if (!message) console.error(`[tasks] ${what} a task failed`, redact({ code: error.code }))
    return { error: actionError(message ?? `The task couldn’t be ${what === 'retrying' ? 'retried' : what.replace(/ing$/, 'ed')}. Please try again.`) }
  }
  revalidatePath(`/app/tasks/${id.data}`)
  revalidatePath('/app/tasks')
  return { id: id.data, result: data as string, supabase }
}

/**
 * Cancels a task. The answer says plainly what cancelling couldn't undo:
 * actions that already changed something outside Nexefiy stay done, and an
 * action running at this moment may still complete.
 */
export async function cancelTask(taskId: string): Promise<ActionState> {
  const outcome = await control(taskId, 'cancel_employee_task', 'cancelling')
  if ('error' in outcome) return outcome.error!
  const { data: actions } = await outcome.supabase.from('tool_executions').select('id, tool_key, risk_level, status').eq('task_id', outcome.id)
  const disclosure = cancellationDisclosure((actions ?? []).map((row) => ({ id: row.id, toolKey: row.tool_key, risk: row.risk_level, status: row.status })))
  const parts = [outcome.result === 'cancel_requested' ? 'Stopping: the employee takes no further steps after the current one.' : 'Cancelled. Nothing more will run.']
  if (disclosure.done.length) {
    parts.push(`${disclosure.done.length} action${disclosure.done.length === 1 ? '' : 's'} had already been carried out (${[...new Set(disclosure.done.map((action) => action.toolKey))].join(', ')}) and can’t be undone by cancelling.`)
  }
  if (disclosure.inProgress.length) parts.push(`${disclosure.inProgress.length} action${disclosure.inProgress.length === 1 ? ' was' : 's were'} running and may still complete.`)
  return actionSuccess(parts.join(' '))
}

export async function pauseTask(taskId: string): Promise<ActionState> {
  const outcome = await control(taskId, 'pause_employee_task', 'pausing')
  if ('error' in outcome) return outcome.error!
  return actionSuccess(outcome.result === 'pause_requested' ? 'Pausing after the current step.' : 'Paused. Nothing runs until you resume it.')
}

export async function resumeTask(taskId: string): Promise<ActionState> {
  const outcome = await control(taskId, 'resume_employee_task', 'resuming')
  if ('error' in outcome) return outcome.error!
  scheduleTaskProcessing({ reason: 'resumed' })
  return actionSuccess(outcome.result === 'running' ? 'The pause was withdrawn; the task keeps running.' : 'Resumed. It continues from where it stopped.')
}

export async function retryTask(taskId: string): Promise<ActionState> {
  const outcome = await control(taskId, 'retry_employee_task', 'retrying')
  if ('error' in outcome) return outcome.error!
  scheduleTaskProcessing({ reason: 'retried' })
  return actionSuccess('Retrying from the last checkpoint, with a fresh set of limits. Actions that already ran are not repeated.')
}

const prioritySchema = z.object({ taskId: z.uuid(), priority: z.coerce.number().int().min(-100).max(100) })

export async function setTaskPriority(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = prioritySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError('Choose a priority.')
  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')
  const { error } = await supabase.rpc('set_employee_task_priority', { p_task_id: parsed.data.taskId, p_priority: parsed.data.priority })
  if (error) {
    const message = (error.code && STATE_ERRORS[error.code]) ?? null
    if (!message) console.error('[tasks] changing a task’s priority failed', redact({ code: error.code }))
    return actionError(message ?? 'The priority couldn’t be changed. Please try again.')
  }
  revalidatePath(`/app/tasks/${parsed.data.taskId}`)
  revalidatePath('/app/tasks')
  return actionSuccess('Priority updated.')
}

const reassignSchema = z.object({ taskId: z.uuid(), employeeId: z.uuid('Choose an employee.') })

export async function reassignTask(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = reassignSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError('Choose an employee.')
  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')
  const { data, error } = await supabase.rpc('reassign_employee_task', { p_task_id: parsed.data.taskId, p_employee_id: parsed.data.employeeId })
  if (error) {
    const message =
      error.code === '55000' ? 'Only a task that hasn’t started can be reassigned, and only to an active employee.' : ((error.code && STATE_ERRORS[error.code]) ?? null)
    if (!message) console.error('[tasks] reassigning a task failed', redact({ code: error.code }))
    return actionError(message ?? 'The task couldn’t be reassigned. Please try again.')
  }
  revalidatePath(`/app/tasks/${parsed.data.taskId}`)
  revalidatePath('/app/tasks')
  return actionSuccess(data === 'unchanged' ? 'It’s already assigned to that employee.' : 'Reassigned. The new employee’s active version will do it.')
}

const replySchema = z.object({
  taskId: z.uuid(),
  message: z.string().trim().min(1, 'Write a reply.').max(4000, 'Keep the reply under 4,000 characters.'),
})

const REPLY_ERRORS: Record<string, string> = {
  P0002: 'That task doesn’t exist, or your role can’t answer it.',
  '55000': 'This task isn’t waiting for a reply anymore.',
  '22023': 'Write a reply of up to 4,000 characters.',
  '23514': 'The reply contains something that looks like a password, token or API key.',
}

export async function replyToTask(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = replySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError('Check your reply and try again.', z.flattenError(parsed.error).fieldErrors)
  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { error } = await supabase.rpc('reply_to_employee_task', { p_task_id: parsed.data.taskId, p_message: parsed.data.message })
  if (error) {
    const message = (error.code && REPLY_ERRORS[error.code]) ?? null
    if (!message) console.error('[tasks] replying to a task failed', redact({ code: error.code }))
    return actionError(message ?? 'The reply couldn’t be sent. Please try again.')
  }
  scheduleTaskProcessing({ reason: 'replied' })
  revalidatePath(`/app/tasks/${parsed.data.taskId}`)
  return actionSuccess('Sent. The employee continues with your reply.')
}

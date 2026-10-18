'use server'

// Server Actions for employee tasks: assigning, cancelling, replying to an
// escalation. Each runs under the user's own session through a SQL function
// (assign_employee_task, cancel_employee_task, reply_to_employee_task) that
// checks the role, the organization and the task's state; the work itself is
// done by the task runtime after the response (and by the cron route).

import { randomUUID } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { redact } from '@/lib/logging/redact'
import { createRateLimiter } from '@/lib/rate-limit'
import { createUserClient } from '@/lib/supabase/server'
import { getVerifiedUser, SESSION_ENDED_MESSAGE } from '@/modules/identity/server/session'

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
})

const ASSIGN_ERRORS: Record<string, string> = {
  P0002: 'That employee doesn’t exist in this workspace, or your role can’t assign tasks.',
  '55000': 'Only an active employee can be given tasks.',
  '22023': 'Check the task’s title and details.',
  '23514': 'The task contains something that looks like a password, token or API key. Remove it and try again.',
}

export async function assignTask(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = assignSchema.safeParse(Object.fromEntries(formData))
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
  })
  if (error || !data) {
    const message = (error?.code && ASSIGN_ERRORS[error.code]) ?? null
    if (!message) console.error('[tasks] assigning a task failed', redact({ code: error?.code }))
    return actionError(message ?? 'The task couldn’t be assigned. Please try again.')
  }

  scheduleTaskProcessing()
  revalidatePath('/app/tasks')
  revalidatePath(`/app/employees/${parsed.data.employeeId}`)
  redirect(`/app/tasks/${data}${canRunTasks() ? '' : '?unavailable=1'}`)
}

const taskIdSchema = z.uuid()

export async function cancelTask(taskId: string): Promise<ActionState> {
  const id = taskIdSchema.safeParse(taskId)
  if (!id.success) return actionError('That task doesn’t exist.')
  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase.rpc('cancel_employee_task', { p_task_id: id.data })
  if (error) {
    const message = error.code === 'P0002' ? 'That task doesn’t exist, or your role can’t cancel it.' : error.code === '55000' ? 'This task has already finished.' : null
    if (!message) console.error('[tasks] cancelling a task failed', redact({ code: error.code }))
    return actionError(message ?? 'The task couldn’t be cancelled. Please try again.')
  }
  revalidatePath(`/app/tasks/${id.data}`)
  revalidatePath('/app/tasks')
  return actionSuccess(data === 'cancel_requested' ? 'Stopping: the task ends after its current step.' : 'Cancelled.')
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
  scheduleTaskProcessing()
  revalidatePath(`/app/tasks/${parsed.data.taskId}`)
  return actionSuccess('Sent. The employee continues with your reply.')
}

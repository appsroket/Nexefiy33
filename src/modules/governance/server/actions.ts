'use server'

// Server Actions for governance: workspace policies, the emergency stop (for
// the workspace and for one employee), revoking an employee's tool, human
// handoff of a task, and evidence retention. Each runs under the user's own
// session: RLS, column grants and the SQL functions check the role, the
// organization and the state again, so calling the API directly gets the same
// answers as these forms (tests/integration/governance.test.ts, pgTAP 013).

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'
import { hasMinRole, type Json, type OrganizationRole } from '@/lib/supabase/types'
import { SESSION_ENDED_MESSAGE } from '@/modules/identity/server/session'
import { findAction } from '@/modules/integrations/connectors/registry'
import { getVerifiedMember } from '@/modules/integrations/server/membership'
import { scheduleTaskProcessing } from '@/modules/tasks/server/scheduling'

import { EMERGENCY_STOP_CONFIRMATION } from '../domain/controls'
import { ACTION_CATEGORY_INFO } from '../domain/risk'
import { policyDocumentSchema, policySettingsSchema, retentionSchema } from '../domain/schemas'

const NOT_ALLOWED = 'That isn’t available in this workspace, or your role can’t do it.'

async function member(organizationId: string, minimum: OrganizationRole) {
  const check = await getVerifiedMember(organizationId)
  if (check.status === 'signed_out') return { ok: false as const, state: actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended') }
  if (check.status !== 'ok' || !hasMinRole(check.role, minimum)) {
    return { ok: false as const, state: actionError(minimum === 'admin' ? 'Only admins and owners can do that.' : minimum === 'operator' ? 'Viewers can’t do that.' : NOT_ALLOWED) }
  }
  return { ok: true as const, user: check.user, role: check.role }
}

function failed(what: string, code: string | undefined, messages: Record<string, string>): ActionState {
  const message = (code && messages[code]) ?? null
  if (!message) console.error(`[governance] ${what} failed`, redact({ code }))
  return actionError(message ?? 'That couldn’t be saved. Please try again.')
}

// --- Policies -------------------------------------------------------------------

const policyInputSchema = z.object({
  organizationId: z.uuid(),
  policyId: z.uuid().nullable(),
  settings: policySettingsSchema,
  document: policyDocumentSchema,
})

const POLICY_ERRORS: Record<string, string> = {
  '23505': 'Another policy already has that name.',
  '23514': 'The policy isn’t valid. Check its rules and limits.',
  '42501': 'Only admins and owners can change policies.',
}

/**
 * Creates or updates a policy. The database records who saved it and with
 * which role, and keeps every revision. An "allow" for a critical action only
 * takes effect when an owner saved the policy; the answer says so.
 */
export async function savePolicy(input: unknown): Promise<ActionState> {
  const parsed = policyInputSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return actionError(issue ? `${issue.path.join(' → ') || 'Policy'}: ${issue.message}` : 'The policy couldn’t be read.')
  }
  const { organizationId, policyId, settings, document } = parsed.data
  const caller = await member(organizationId, 'admin')
  if (!caller.ok) return caller.state

  const supabase = await createUserClient()
  const values = { ...settings, policy_schema_version: 2, policy: document as unknown as Json }
  const { data, error } = policyId
    ? await supabase.from('organization_policies').update(values).eq('id', policyId).eq('organization_id', organizationId).select('id, revision').maybeSingle()
    : await supabase
        .from('organization_policies')
        .insert({ organization_id: organizationId, ...values })
        .select('id, revision')
        .single()
  if (error) return failed('saving a policy', error.code, POLICY_ERRORS)
  if (!data) return actionError(NOT_ALLOWED)

  const notes: string[] = []
  const critical = document.rules
    .filter((rule) => rule.effect === 'allow')
    .flatMap((rule) => rule.toolKeys ?? [])
    .filter((key) => {
      const found = findAction(key)
      return found && ACTION_CATEGORY_INFO[found.action.category].tier === 'critical'
    })
  if (critical.length && caller.role !== 'owner') notes.push(`The “allow” for ${critical.join(', ')} takes effect only when an owner saves this policy.`)
  revalidatePath('/app/settings/governance')
  return actionSuccess([`Saved as revision ${data.revision}.`, ...notes].join(' '), { id: data.id })
}

export async function deletePolicy(organizationId: string, policyId: string): Promise<ActionState> {
  const ids = z.object({ organizationId: z.uuid(), policyId: z.uuid() }).safeParse({ organizationId, policyId })
  if (!ids.success) return actionError(NOT_ALLOWED)
  const caller = await member(organizationId, 'admin')
  if (!caller.ok) return caller.state
  const supabase = await createUserClient()
  const { data, error } = await supabase.from('organization_policies').delete().eq('id', policyId).eq('organization_id', organizationId).select('id')
  if (error) return failed('deleting a policy', error.code, POLICY_ERRORS)
  if (!data.length) return actionError(NOT_ALLOWED)
  revalidatePath('/app/settings/governance')
  return actionSuccess('Deleted. Its history is kept.')
}

// --- Emergency stop -----------------------------------------------------------------

const stopSchema = z.object({
  organizationId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why you’re stopping.').max(500),
  confirm: z.string().trim(),
})

const STOP_ERRORS: Record<string, string> = {
  P0002: 'Only admins and owners can use the emergency stop.',
  '55000': 'The emergency stop is already on (or already off). Refresh the page.',
  '22023': 'Give a reason (up to 500 characters, no credentials).',
}

export async function setEmergencyStop(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = stopSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError(parsed.error.issues[0]?.message ?? 'Say why you’re stopping.')
  if (parsed.data.confirm.toUpperCase() !== EMERGENCY_STOP_CONFIRMATION) return actionError(`Type ${EMERGENCY_STOP_CONFIRMATION} to confirm.`)
  const caller = await member(parsed.data.organizationId, 'admin')
  if (!caller.ok) return caller.state
  const supabase = await createUserClient()
  const { data, error } = await supabase.rpc('set_emergency_stop', { p_organization_id: parsed.data.organizationId, p_reason: parsed.data.reason })
  if (error) return failed('setting the emergency stop', error.code, STOP_ERRORS)
  const counts = (data ?? {}) as { paused_tasks?: number; stopping_tasks?: number; withdrawn_actions?: number; cancelled_runs?: number }
  revalidatePath('/app', 'layout')
  return actionSuccess(
    `Emergency stop is on. ${counts.paused_tasks ?? 0} task(s) paused, ${counts.stopping_tasks ?? 0} stopping after their current step, ${counts.withdrawn_actions ?? 0} waiting action(s) withdrawn, ${counts.cancelled_runs ?? 0} workflow run(s) cancelled. Actions already running can’t be stopped and may still complete.`,
  )
}

const liftSchema = z.object({ organizationId: z.uuid(), resumeTasks: z.enum(['on']).optional() })

export async function liftEmergencyStop(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = liftSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError(NOT_ALLOWED)
  const caller = await member(parsed.data.organizationId, 'admin')
  if (!caller.ok) return caller.state
  const supabase = await createUserClient()
  const { data, error } = await supabase.rpc('lift_emergency_stop', { p_organization_id: parsed.data.organizationId, p_resume_tasks: parsed.data.resumeTasks === 'on' })
  if (error) return failed('lifting the emergency stop', error.code, STOP_ERRORS)
  const resumed = (data as { resumed_tasks?: number } | null)?.resumed_tasks ?? 0
  if (resumed) scheduleTaskProcessing({ reason: 'resumed' })
  revalidatePath('/app', 'layout')
  return actionSuccess(
    resumed
      ? `Emergency stop lifted. ${resumed} paused task(s) resumed; withdrawn approvals stay withdrawn and are asked for again when needed.`
      : 'Emergency stop lifted. Paused tasks stay paused until someone resumes them.',
  )
}

const employeeStopSchema = z.object({ employeeId: z.uuid(), reason: z.string().trim().min(1, 'Say why you’re stopping it.').max(500) })

export async function emergencyStopEmployee(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = employeeStopSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError(parsed.error.issues[0]?.message ?? 'Say why you’re stopping it.')
  const supabase = await createUserClient()
  const { data, error } = await supabase.rpc('emergency_stop_employee', { p_employee_id: parsed.data.employeeId, p_reason: parsed.data.reason })
  if (error) {
    return failed('stopping an employee', error.code, {
      P0002: 'That employee doesn’t exist here, or viewers can’t stop employees.',
      '22023': 'Give a reason (up to 500 characters, no credentials).',
      '42501': SESSION_ENDED_MESSAGE,
    })
  }
  const counts = (data ?? {}) as { paused_tasks?: number; stopping_tasks?: number; withdrawn_actions?: number }
  revalidatePath(`/app/employees/${parsed.data.employeeId}`)
  revalidatePath('/app/tasks')
  return actionSuccess(
    `Stopped. The employee is paused; ${counts.paused_tasks ?? 0} task(s) paused, ${counts.stopping_tasks ?? 0} stopping after the current step, ${counts.withdrawn_actions ?? 0} waiting action(s) withdrawn. An admin can resume it once tests still pass.`,
  )
}

// --- Revocation ----------------------------------------------------------------------

const revokeSchema = z.object({ employeeId: z.uuid(), toolKey: z.string().max(100), integrationId: z.uuid().nullable() })

export async function revokeEmployeeTool(employeeId: string, toolKey: string, integrationId: string | null): Promise<ActionState> {
  const parsed = revokeSchema.safeParse({ employeeId, toolKey, integrationId })
  if (!parsed.success) return actionError(NOT_ALLOWED)
  const supabase = await createUserClient()
  const { error } = await supabase.rpc('revoke_employee_tool', {
    p_employee_id: parsed.data.employeeId,
    p_tool_key: parsed.data.toolKey,
    ...(parsed.data.integrationId ? { p_integration_id: parsed.data.integrationId } : {}),
  })
  if (error) return failed('revoking a tool', error.code, { P0002: 'Only admins and owners can revoke tools, and only ones the employee has.', '42501': SESSION_ENDED_MESSAGE })
  revalidatePath(`/app/employees/${parsed.data.employeeId}`)
  return actionSuccess('Revoked. Actions waiting on it were cancelled, and the employee can’t use it until a version that grants it is activated again.')
}

// --- Human handoff ---------------------------------------------------------------------

const handOffSchema = z.object({
  taskId: z.uuid(),
  assignee: z.uuid().optional(),
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => value || null),
})

const HANDOFF_ERRORS: Record<string, string> = {
  P0002: 'That task doesn’t exist here, or viewers can’t take tasks over.',
  '55000': 'This task can’t be handed over in its current state. A running task must be paused first.',
  '22023': 'The person taking over must be an operator or above in this workspace, and the note must not contain credentials.',
  '42501': 'Only the person who took the task over, or an admin, can complete it.',
}

export async function handOffTask(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = handOffSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError('Check the note (up to 2,000 characters).')
  const supabase = await createUserClient()
  const { error } = await supabase.rpc('hand_off_employee_task', {
    p_task_id: parsed.data.taskId,
    ...(parsed.data.assignee ? { p_assignee: parsed.data.assignee } : {}),
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  })
  if (error) return failed('handing off a task', error.code, HANDOFF_ERRORS)
  revalidatePath(`/app/tasks/${parsed.data.taskId}`)
  revalidatePath('/app/tasks')
  return actionSuccess('Handed over. The employee won’t work on this task again; its waiting actions were withdrawn.')
}

const completeSchema = z.object({
  taskId: z.uuid(),
  outcome: z.enum(['done', 'cancelled']),
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => value || null),
})

export async function completeHandedOffTask(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = completeSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError('Choose an outcome.')
  const supabase = await createUserClient()
  const { error } = await supabase.rpc('complete_handed_off_task', {
    p_task_id: parsed.data.taskId,
    p_outcome: parsed.data.outcome,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  })
  if (error) return failed('completing a handed-off task', error.code, HANDOFF_ERRORS)
  revalidatePath(`/app/tasks/${parsed.data.taskId}`)
  revalidatePath('/app/tasks')
  return actionSuccess(parsed.data.outcome === 'done' ? 'Marked as done by you.' : 'Closed without completing it.')
}

// --- Retention ----------------------------------------------------------------------

const daysField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))

const retentionFormSchema = z.object({
  organizationId: z.uuid(),
  evidenceDays: daysField,
  eventDays: daysField,
  payloadDays: daysField,
  hold: z.enum(['on']).optional(),
})

export async function saveRetention(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const form = retentionFormSchema.safeParse(Object.fromEntries(formData))
  if (!form.success) return actionError(NOT_ALLOWED)
  const parsed = retentionSchema.safeParse({ evidenceDays: form.data.evidenceDays, eventDays: form.data.eventDays, payloadDays: form.data.payloadDays, hold: form.data.hold === 'on' })
  if (!parsed.success) return actionError(`Retention: ${parsed.error.issues[0]?.message ?? 'check the values'} Leave a field empty to keep that data.`)
  const caller = await member(form.data.organizationId, 'admin')
  if (!caller.ok) return caller.state
  const supabase = await createUserClient()
  const { error } = await supabase.rpc('set_retention_settings', {
    p_organization_id: form.data.organizationId,
    // Null keeps that data (the generated types don't mark these arguments nullable).
    p_evidence_days: parsed.data.evidenceDays as number,
    p_event_days: parsed.data.eventDays as number,
    p_payload_days: parsed.data.payloadDays as number,
    p_hold: parsed.data.hold,
  })
  if (error) return failed('saving retention', error.code, { P0002: 'Only admins and owners can change retention.', '23514': 'Retention must be between 30 and 3,650 days.' })
  revalidatePath('/app/settings/governance')
  return actionSuccess(parsed.data.hold ? 'Saved. A hold is on, so nothing is purged until you lift it.' : 'Saved. Older data is purged by the daily governance job.')
}

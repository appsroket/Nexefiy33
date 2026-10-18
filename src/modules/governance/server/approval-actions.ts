'use server'

// Approving or rejecting a request. The decision runs under the user's own
// session through decide_approval, which checks the required role, the
// expiry, and that the payload fingerprint is the one the approver saw (a
// changed action can't be approved by an old screen). An approved action is
// then run by the integration executor, which re-checks the connection,
// permissions and payload before calling the provider.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'
import { getVerifiedUser, SESSION_ENDED_MESSAGE } from '@/modules/identity/server/session'
import { closeRejectedTask, scheduleApprovedExecutions } from '@/modules/integrations/server/scheduling'

const decisionSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(['approved', 'rejected']),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => value || null),
})

const MESSAGES: Record<string, string> = {
  P0002: 'This request doesn’t exist or needs a higher role to decide.',
  '55000': 'This request has already been decided.',
  '40001': 'The proposed action changed after you opened it. Reload and review it again.',
}

export async function decideApproval(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = decisionSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError('This decision couldn’t be read. Reload and try again.')
  const { requestId, decision, payloadSha256, note } = parsed.data

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase.rpc('decide_approval', {
    p_request_id: requestId,
    p_decision: decision,
    p_payload_sha256: payloadSha256,
    ...(note ? { p_note: note } : {}),
  })
  if (error) {
    const message = (error.code && MESSAGES[error.code]) ?? null
    if (!message) console.error('[governance] deciding an approval failed', redact({ code: error.code }))
    return actionError(message ?? 'The decision couldn’t be saved. Please try again.')
  }

  revalidatePath('/app/approvals')
  revalidatePath(`/app/approvals/${requestId}`)

  if (data.status === 'expired') return actionError('This request expired before it was decided; the action was cancelled.')
  if (data.status === 'approved') {
    scheduleApprovedExecutions()
    return actionSuccess('Approved. The action will run in a moment; its result appears on the integration page.')
  }

  await closeRejectedTask(data.organization_id, data.task_id)
  return actionSuccess('Rejected. The action will not run.')
}

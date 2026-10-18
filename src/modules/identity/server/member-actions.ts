'use server'

// Members and invitations. The database decides who may change whom (RLS plus
// private.guard_membership_change and public.create_invitation); these
// actions validate input, run the change under the user's own session, and
// explain refusals in plain language.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { parseFormData } from '@/lib/forms/parse-form'
import { getServerEnv } from '@/lib/env/server'
import { createUserClient, type UserClient } from '@/lib/supabase/server'
import { ORGANIZATION_ROLES, type OrganizationRole } from '@/lib/supabase/types'

import { invitationLink } from '../domain/invitations'
import { inviteSchema } from '../domain/schemas'
import { deliverInvitation } from './invitation-delivery'
import { getVerifiedUser, SESSION_ENDED_MESSAGE, type VerifiedUser } from './session'

const MEMBERS_PATH = '/app/settings/members'
const NOT_ALLOWED = 'You don’t have permission to do that in this workspace.'

const ids = z.object({ organizationId: z.uuid(), targetId: z.uuid() })

function logFailure(action: string, error: { code?: string } | null) {
  console.error(`[identity] ${action} failed`, { code: error?.code ?? 'unknown' })
}

async function session(): Promise<{ supabase: UserClient; user: VerifiedUser } | null> {
  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  return user ? { supabase, user } : null
}

/** Database refusals from private.guard_membership_change, in plain language. */
function membershipError(error: { code?: string; message?: string }): string {
  if (error.code === '23514') return 'A workspace must always have an owner. Make someone else an owner first.'
  if (error.code === '42501') {
    if (error.message?.includes('admins can only manage')) return 'Admins can only manage operators and viewers.'
    if (error.message?.includes('only owners can change their own')) return 'Only owners can change their own role.'
    return NOT_ALLOWED
  }
  return 'We couldn’t save that change. Please try again.'
}

export async function changeMemberRole(organizationId: string, userId: string, role: string): Promise<ActionState> {
  const parsed = ids.safeParse({ organizationId, targetId: userId })
  const parsedRole = z.enum(ORGANIZATION_ROLES).safeParse(role)
  if (!parsed.success || !parsedRole.success) return actionError(NOT_ALLOWED)

  const context = await session()
  if (!context) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await context.supabase
    .from('organization_members')
    .update({ role: parsedRole.data })
    .eq('organization_id', parsed.data.organizationId)
    .eq('user_id', parsed.data.targetId)
    .eq('status', 'active')
    .select('user_id')
  if (error) {
    if (error.code !== '42501' && error.code !== '23514') logFailure('role change', error)
    return actionError(membershipError(error))
  }
  if (data.length === 0) return actionError(NOT_ALLOWED)

  revalidatePath('/app', 'layout')
  return actionSuccess('Role updated.')
}

/**
 * Removes someone from the workspace. The membership is marked revoked (not
 * deleted) so the record of who removed whom, and when, is kept; access ends
 * immediately because every policy only counts active memberships.
 */
export async function removeMember(organizationId: string, userId: string): Promise<ActionState> {
  const parsed = ids.safeParse({ organizationId, targetId: userId })
  if (!parsed.success) return actionError(NOT_ALLOWED)

  const context = await session()
  if (!context) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')
  if (context.user.id === parsed.data.targetId) return actionError('To remove yourself, use “Leave workspace”.')

  const { data, error } = await context.supabase
    .from('organization_members')
    .update({ status: 'revoked' })
    .eq('organization_id', parsed.data.organizationId)
    .eq('user_id', parsed.data.targetId)
    .eq('status', 'active')
    .select('user_id')
  if (error) {
    if (error.code !== '42501' && error.code !== '23514') logFailure('member removal', error)
    return actionError(membershipError(error))
  }
  if (data.length === 0) return actionError(NOT_ALLOWED)

  revalidatePath('/app', 'layout')
  return actionSuccess('Member removed.')
}

interface CreatedInvitation {
  token: string
  expiresAt: string
}

async function createAndDeliver(
  context: { supabase: UserClient; user: VerifiedUser },
  organizationId: string,
  email: string,
  role: Exclude<OrganizationRole, 'owner'>,
): Promise<ActionState> {
  const { data, error } = await context.supabase.rpc('create_invitation', {
    p_organization_id: organizationId,
    p_email: email,
    p_role: role,
  })
  if (error) {
    if (error.code === '23505' && error.message.includes('already a member')) {
      return actionError('Please correct the highlighted fields.', { email: ['This person is already a member.'] })
    }
    if (error.code === '23505') {
      return actionError('Please correct the highlighted fields.', {
        email: ['This address already has a pending invitation. Resend or revoke it below.'],
      })
    }
    if (error.code === '42501') {
      return actionError(role === 'admin' ? 'Only owners can invite admins.' : NOT_ALLOWED)
    }
    logFailure('invitation', error)
    return actionError('We couldn’t create the invitation. Please try again.')
  }
  const created: CreatedInvitation | undefined = data[0] ? { token: data[0].token, expiresAt: data[0].expires_at } : undefined
  if (!created) {
    logFailure('invitation', { code: 'no_rows' })
    return actionError('We couldn’t create the invitation. Please try again.')
  }

  const [workspace, inviter] = await Promise.all([
    context.supabase.from('organizations').select('name').eq('id', organizationId).maybeSingle(),
    context.supabase.from('profiles').select('full_name, email').eq('id', context.user.id).maybeSingle(),
  ])
  const delivery = await deliverInvitation({
    to: email,
    token: created.token,
    organizationName: workspace.data?.name ?? 'a workspace',
    inviterName: inviter.data?.full_name?.trim() || inviter.data?.email || 'A teammate',
    role,
    expiresAt: created.expiresAt,
  })

  revalidatePath(MEMBERS_PATH)
  if (delivery === 'sent') return actionSuccess(`Invitation sent to ${email}.`)
  // Shown once, to the person who created the invitation; never stored or logged.
  const link = invitationLink(getServerEnv().core.appUrl, created.token)
  return actionSuccess(
    delivery === 'not_configured'
      ? `Invitation created for ${email}. Email isn’t set up yet, so send them this link yourself.`
      : `Invitation created for ${email}, but the email couldn’t be sent. Send them this link yourself.`,
    { link, email },
  )
}

export async function inviteMember(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const organizationId = z.uuid().safeParse(formData.get('organizationId'))
  if (!organizationId.success) return actionError(NOT_ALLOWED)
  const parsed = parseFormData(inviteSchema, formData)
  if (!parsed.ok) return parsed.state

  const context = await session()
  if (!context) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')
  return createAndDeliver(context, organizationId.data, parsed.data.email, parsed.data.role)
}

export async function revokeInvitation(organizationId: string, invitationId: string): Promise<ActionState> {
  const parsed = ids.safeParse({ organizationId, targetId: invitationId })
  if (!parsed.success) return actionError(NOT_ALLOWED)

  const context = await session()
  if (!context) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await context.supabase
    .from('organization_invitations')
    .update({ status: 'revoked' })
    .eq('id', parsed.data.targetId)
    .eq('organization_id', parsed.data.organizationId)
    .eq('status', 'pending')
    .select('id')
  if (error) {
    logFailure('invitation revocation', error)
    return actionError('We couldn’t revoke the invitation. Please try again.')
  }
  if (data.length === 0) return actionError('This invitation can’t be revoked. It may already have been used or revoked.')

  revalidatePath(MEMBERS_PATH)
  return actionSuccess('Invitation revoked.')
}

/** Replaces an invitation with a fresh one (new link, new expiry) for the same address and role. */
export async function resendInvitation(organizationId: string, invitationId: string): Promise<ActionState> {
  const parsed = ids.safeParse({ organizationId, targetId: invitationId })
  if (!parsed.success) return actionError(NOT_ALLOWED)

  const context = await session()
  if (!context) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data: invitation, error } = await context.supabase
    .from('organization_invitations')
    .select('email, role, status')
    .eq('id', parsed.data.targetId)
    .eq('organization_id', parsed.data.organizationId)
    .maybeSingle()
  if (error) {
    logFailure('reading an invitation', error)
    return actionError('We couldn’t resend the invitation. Please try again.')
  }
  const role = z.enum(['admin', 'operator', 'viewer']).safeParse(invitation?.role)
  if (!invitation || !role.success || (invitation.status !== 'pending' && invitation.status !== 'expired')) {
    return actionError('This invitation can’t be resent.')
  }

  if (invitation.status === 'pending') {
    const { error: revokeError } = await context.supabase
      .from('organization_invitations')
      .update({ status: 'revoked' })
      .eq('id', parsed.data.targetId)
      .eq('organization_id', parsed.data.organizationId)
      .eq('status', 'pending')
    if (revokeError) {
      logFailure('replacing an invitation', revokeError)
      return actionError('We couldn’t resend the invitation. Please try again.')
    }
  }
  return createAndDeliver(context, parsed.data.organizationId, invitation.email, role.data)
}

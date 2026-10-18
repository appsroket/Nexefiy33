'use server'

// Looking up and accepting an invitation from its link. The token comes from
// the URL fragment, read in the browser and sent here in the request body.

import { revalidatePath } from 'next/cache'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { createUserClient } from '@/lib/supabase/server'
import { isOrganizationRole } from '@/modules/app-shell/domain/workspace'
import { rememberWorkspace } from '@/modules/app-shell/server/workspace-cookie'
import type { OrganizationRole } from '@/lib/supabase/types'

import { effectiveInvitationStatus, isInvitationToken, type InvitationStatus } from '../domain/invitations'
import { getVerifiedUser } from './session'

export type InvitationLookup =
  | { status: 'signed_out' }
  | { status: 'not_found' }
  | { status: 'error' }
  | {
      status: 'found'
      signedInEmail: string | null
      invitation: {
        organizationName: string
        role: OrganizationRole
        status: InvitationStatus
        invitedEmail: string
        emailMatches: boolean
        alreadyMember: boolean
        expiresAt: string
      }
    }

export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  if (!user) return { status: 'signed_out' }
  if (!isInvitationToken(token)) return { status: 'not_found' }

  const { data, error } = await supabase.rpc('get_invitation', { p_token: token })
  if (error) {
    console.error('[identity] invitation lookup failed', { code: error.code ?? 'unknown' })
    return { status: 'error' }
  }
  const row = data[0]
  if (!row || !isOrganizationRole(row.role)) return { status: 'not_found' }

  return {
    status: 'found',
    signedInEmail: user.email,
    invitation: {
      organizationName: row.organization_name,
      role: row.role,
      status: effectiveInvitationStatus(row.status, row.expires_at),
      invitedEmail: row.invited_email,
      emailMatches: row.email_matches,
      alreadyMember: row.already_member,
      expiresAt: row.expires_at,
    },
  }
}

/** Joins the workspace and makes it the active one. The caller navigates on success. */
export async function acceptInvitation(token: string): Promise<ActionState> {
  if (!isInvitationToken(token)) return actionError('This invitation link isn’t valid.')

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) {
    return actionError('Your session has ended. Please sign in again.', undefined, 'session_ended')
  }

  const { data, error } = await supabase.rpc('accept_invitation', { p_token: token })
  if (error) {
    if (error.code === '23505') return actionError('You’re already a member of this workspace.', undefined, 'already_member')
    if (error.code === '22023') {
      return actionError(
        'This invitation can’t be used. It may have expired, been revoked or already used, or it was sent to a different email address.',
      )
    }
    console.error('[identity] invitation acceptance failed', { code: error.code ?? 'unknown' })
    return actionError('We couldn’t accept the invitation. Please try again.')
  }

  await rememberWorkspace(data)
  revalidatePath('/app', 'layout')
  return actionSuccess('You’ve joined the workspace.')
}

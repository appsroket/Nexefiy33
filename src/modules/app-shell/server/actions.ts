'use server'

// Server Actions for the shell. Each one re-reads the session and re-checks
// membership itself; nothing sent by the browser is trusted.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'

import { forgetWorkspace, rememberWorkspace } from './workspace-cookie'

/** Remembers the chosen workspace after confirming the user is an active member of it. */
export async function switchWorkspace(organizationId: string): Promise<ActionState> {
  const parsed = z.uuid().safeParse(organizationId)
  if (!parsed.success) return actionError('That workspace could not be found.')

  const supabase = await createUserClient()
  const { data: claimsData } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub
  if (!userId) return actionError('Your session has ended. Please sign in again.')

  const { data, error } = await supabase
    .from('organization_members')
    .select('organization_id')
    .eq('organization_id', parsed.data)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) {
    console.error('[app-shell] workspace switch failed', redact(error))
    return actionError('We couldn’t switch workspaces. Please try again.')
  }
  if (!data) return actionError('You are not a member of that workspace.')

  await rememberWorkspace(data.organization_id)
  revalidatePath('/app', 'layout')
  return actionSuccess()
}

/** Ends this browser's session. Other devices stay signed in (see signOutEverywhere). */
export async function signOut(): Promise<void> {
  const supabase = await createUserClient()
  const { error } = await supabase.auth.signOut({ scope: 'local' })
  if (error) console.error('[app-shell] sign-out failed', redact(error))
  await forgetWorkspace()
  redirect('/sign-in?signed_out=1')
}

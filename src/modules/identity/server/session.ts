// Session checks for Server Actions.

import 'server-only'

import type { UserClient } from '@/lib/supabase/server'

export interface VerifiedUser {
  id: string
  email: string | null
}

export const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.'

/**
 * Confirms the session with Supabase Auth (a network call). Unlike the local
 * token check used to render pages, this rejects a session that was ended
 * elsewhere (sign out everywhere, password change) even though its access
 * token hasn't expired yet. Every Server Action that changes data calls it.
 */
export async function getVerifiedUser(supabase: UserClient): Promise<VerifiedUser | null> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  return { id: data.user.id, email: data.user.email ?? null }
}

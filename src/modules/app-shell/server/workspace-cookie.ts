// The remembered active workspace. Only a preference: getShellContext() checks
// it against the user's current memberships on every request, so a stale or
// tampered value can never select a workspace the user doesn't belong to.

import 'server-only'

import { cookies } from 'next/headers'

import { getServerEnv } from '@/lib/env/server'

import { ACTIVE_WORKSPACE_COOKIE } from '../domain/workspace'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

/** Call only after confirming the user is an active member of the workspace. */
export async function rememberWorkspace(organizationId: string): Promise<void> {
  ;(await cookies()).set(ACTIVE_WORKSPACE_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: getServerEnv().appEnv !== 'development',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  })
}

export async function forgetWorkspace(): Promise<void> {
  ;(await cookies()).delete(ACTIVE_WORKSPACE_COOKIE)
}

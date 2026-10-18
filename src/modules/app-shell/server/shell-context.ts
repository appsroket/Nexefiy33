// Loads what the application shell needs for the current request: the
// signed-in user, their workspaces, the active workspace, and notifications.
// Every query runs with the user's own session, so RLS decides what is visible.

import 'server-only'

import { cookies } from 'next/headers'
import { cache } from 'react'

import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'

import {
  ACTIVE_WORKSPACE_COOKIE,
  isOrganizationRole,
  resolveActiveWorkspace,
  rolesAtOrBelow,
  sortWorkspaces,
  type WorkspaceMembership,
} from '../domain/workspace'

export interface ShellUser {
  id: string
  email: string | null
  /** The name the person entered, if any (displayName falls back to the email). */
  fullName: string | null
  displayName: string
  avatarUrl: string | null
}

export interface ShellNotification {
  id: string
  kind: 'approval'
  title: string
  href: string
  createdAt: string
  expiresAt: string
}

export type ShellContext =
  | { status: 'signed_out' }
  | {
      status: 'signed_in'
      user: ShellUser
      workspaces: WorkspaceMembership[]
      activeWorkspace: WorkspaceMembership | null
      notifications: { items: ShellNotification[]; total: number }
    }

const NOTIFICATION_LIMIT = 5

/** Thrown when Supabase cannot be reached or rejects a shell query. Its message is safe to show. */
export class ShellDataError extends Error {
  override name = 'ShellDataError'
}

function fail(what: string, error: unknown): never {
  console.error(`[app-shell] failed to load ${what}`, redact(error))
  throw new ShellDataError(`We couldn't load your ${what}. Please try again in a moment.`)
}

/** Memoized per request, so the layout and pages share one set of queries. */
export const getShellContext = cache(async (): Promise<ShellContext> => {
  const supabase = await createUserClient()

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const claims = claimsData?.claims
  if (claimsError || !claims?.sub) return { status: 'signed_out' }
  const userId = claims.sub

  const [profileResult, membershipResult] = await Promise.all([
    supabase.from('profiles').select('full_name, email, avatar_url').eq('id', userId).maybeSingle(),
    supabase
      .from('organization_members')
      .select('organization_id, role, organizations(name, slug)')
      .eq('user_id', userId)
      .eq('status', 'active'),
  ])
  if (profileResult.error) fail('profile', profileResult.error)
  if (membershipResult.error) fail('workspaces', membershipResult.error)

  const workspaces = sortWorkspaces(
    membershipResult.data.flatMap((row) =>
      row.organizations && isOrganizationRole(row.role)
        ? [{ organizationId: row.organization_id, name: row.organizations.name, slug: row.organizations.slug, role: row.role }]
        : [],
    ),
  )

  const preferredId = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value
  const activeWorkspace = resolveActiveWorkspace(workspaces, preferredId)

  const email = profileResult.data?.email ?? (typeof claims.email === 'string' ? claims.email : null)
  const fullName = profileResult.data?.full_name?.trim() || null
  const user: ShellUser = {
    id: userId,
    email,
    fullName,
    displayName: fullName || email || 'Your account',
    avatarUrl: profileResult.data?.avatar_url ?? null,
  }

  const notifications = activeWorkspace
    ? await loadApprovalNotifications(supabase, activeWorkspace)
    : { items: [], total: 0 }

  return { status: 'signed_in', user, workspaces, activeWorkspace, notifications }
})

/** Pending, unexpired approval requests this member's role is allowed to decide. */
async function loadApprovalNotifications(
  supabase: Awaited<ReturnType<typeof createUserClient>>,
  workspace: WorkspaceMembership,
): Promise<{ items: ShellNotification[]; total: number }> {
  const { data, count, error } = await supabase
    .from('approval_requests')
    .select('id, action_summary, created_at, expires_at', { count: 'exact' })
    .eq('organization_id', workspace.organizationId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .in('required_role', rolesAtOrBelow(workspace.role))
    .order('created_at', { ascending: false })
    .limit(NOTIFICATION_LIMIT)
  if (error) fail('notifications', error)

  return {
    total: count ?? data.length,
    items: data.map((row) => ({
      id: row.id,
      kind: 'approval',
      title: row.action_summary,
      href: '/app/approvals',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    })),
  }
}

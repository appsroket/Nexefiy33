// Workspace (organization) selection. Pure: the server passes memberships it
// loaded under RLS plus the remembered choice from a cookie.

import { ORGANIZATION_ROLES, type OrganizationRole } from '@/lib/supabase/types'

export const ACTIVE_WORKSPACE_COOKIE = 'nxf_workspace'

export interface WorkspaceMembership {
  organizationId: string
  name: string
  slug: string
  role: OrganizationRole
}

const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
}

export function roleLabel(role: OrganizationRole): string {
  return ROLE_LABELS[role]
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === 'string' && (ORGANIZATION_ROLES as readonly string[]).includes(value)
}

/** Roles at or below `role`, for "can this member act on X?" filters. */
export function rolesAtOrBelow(role: OrganizationRole): OrganizationRole[] {
  return ORGANIZATION_ROLES.slice(0, ORGANIZATION_ROLES.indexOf(role) + 1)
}

export function sortWorkspaces(workspaces: readonly WorkspaceMembership[]): WorkspaceMembership[] {
  return [...workspaces].sort(
    (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.slug.localeCompare(b.slug),
  )
}

/**
 * The remembered workspace if the user still belongs to it, otherwise the
 * first one alphabetically. A stale or tampered cookie can never select a
 * workspace the user is not a member of.
 */
export function resolveActiveWorkspace(
  workspaces: readonly WorkspaceMembership[],
  preferredId: string | undefined,
): WorkspaceMembership | null {
  const sorted = sortWorkspaces(workspaces)
  return sorted.find((workspace) => workspace.organizationId === preferredId) ?? sorted[0] ?? null
}

/** Up to two initials for avatars: "Acme Corp" → "AC", "sam@example.com" → "S". */
export function initials(label: string): string {
  const isEmail = label.includes('@')
  const base = isEmail ? (label.split('@')[0] ?? '') : label
  const words = base
    .split(/[\s._-]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
  const [firstWord, secondWord] = words
  if (!firstWord) return '?'
  if (!isEmail && secondWord) return `${firstWord.charAt(0)}${secondWord.charAt(0)}`.toUpperCase()
  return firstWord.charAt(0).toUpperCase()
}

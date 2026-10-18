// Who may do what to whom inside a workspace. This mirrors the database rules
// (RLS policies and private.guard_membership_change) only so the interface
// can hide controls a person can't use. It is never the authorization: every
// change is re-checked by the database under the user's own session.

import { hasMinRole, ORGANIZATION_ROLES, type OrganizationRole } from '@/lib/supabase/types'

export type InvitableRole = Exclude<OrganizationRole, 'owner'>

export interface MemberRef {
  userId: string
  role: OrganizationRole
}

export function canManageMembers(role: OrganizationRole): boolean {
  return hasMinRole(role, 'admin')
}

export function canEditWorkspace(role: OrganizationRole): boolean {
  return hasMinRole(role, 'admin')
}

export function canDeleteWorkspace(role: OrganizationRole): boolean {
  return role === 'owner'
}

/** Owners may invite admins; admins may invite operators and viewers. */
export function invitableRoles(role: OrganizationRole): InvitableRole[] {
  if (role === 'owner') return ['admin', 'operator', 'viewer']
  if (role === 'admin') return ['operator', 'viewer']
  return []
}

export interface MemberPermissions {
  /** Roles the actor may give the target; empty when the role can't be changed. */
  roleOptions: OrganizationRole[]
  canRemove: boolean
}

/**
 * What `actor` may do to `target`. Leaving (removing yourself) is offered
 * separately. An organization always keeps one owner, so the last owner's
 * role can't be lowered.
 */
export function memberPermissions(actor: MemberRef, target: MemberRef, ownerCount: number): MemberPermissions {
  const none: MemberPermissions = { roleOptions: [], canRemove: false }
  const all = [...ORGANIZATION_ROLES].reverse()

  if (actor.userId === target.userId) {
    if (actor.role !== 'owner' || ownerCount < 2) return none
    return { roleOptions: all, canRemove: false }
  }
  if (actor.role === 'owner') {
    const lastOwner = target.role === 'owner' && ownerCount < 2
    return lastOwner ? none : { roleOptions: all, canRemove: true }
  }
  if (actor.role === 'admin' && !hasMinRole(target.role, 'admin')) {
    return { roleOptions: ['operator', 'viewer'], canRemove: true }
  }
  return none
}

export const ROLE_DESCRIPTIONS: Record<OrganizationRole, string> = {
  owner: 'Full control, including deleting the workspace and managing other owners.',
  admin: 'Manages settings, members and invitations, and sees the audit log.',
  operator: 'Day-to-day work: managing AI employees and deciding routine approvals, once those are available.',
  viewer: 'Can see the workspace but can’t change anything.',
}

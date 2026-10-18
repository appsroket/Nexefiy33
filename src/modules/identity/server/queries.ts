// Reads for the account, settings and overview pages. Every query runs with
// the user's own session, so RLS limits it to what they may see (for example,
// only admins and owners get invitation rows back).

import 'server-only'

import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'
import type { OrganizationRole } from '@/lib/supabase/types'
import { isOrganizationRole } from '@/modules/app-shell/domain/workspace'
import { ShellDataError } from '@/modules/app-shell/server/shell-context'

import { effectiveInvitationStatus, type InvitationStatus } from '../domain/invitations'
import { canManageMembers } from '../domain/members'
import type { OnboardingFacts } from '../domain/onboarding'

function fail(what: string, error: unknown): never {
  console.error(`[identity] failed to load ${what}`, redact(error))
  throw new ShellDataError(`We couldn't load ${what}. Please try again in a moment.`)
}

export interface WorkspaceMember {
  userId: string
  name: string | null
  email: string | null
  role: OrganizationRole
  joinedAt: string
}

export async function listMembers(organizationId: string): Promise<WorkspaceMember[]> {
  const supabase = await createUserClient()
  const { data: members, error } = await supabase
    .from('organization_members')
    .select('user_id, role, created_at')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
  if (error) fail('the member list', error)

  const userIds = members.map((member) => member.user_id)
  const { data: profiles, error: profileError } = userIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', userIds)
    : { data: [], error: null }
  if (profileError) fail('the member list', profileError)
  const byId = new Map(profiles.map((profile) => [profile.id, profile]))

  return members.flatMap((member) =>
    isOrganizationRole(member.role)
      ? [
          {
            userId: member.user_id,
            name: byId.get(member.user_id)?.full_name?.trim() || null,
            email: byId.get(member.user_id)?.email ?? null,
            role: member.role,
            joinedAt: member.created_at,
          },
        ]
      : [],
  )
}

export interface WorkspaceInvitation {
  id: string
  email: string
  role: OrganizationRole
  status: InvitationStatus
  expiresAt: string
  createdAt: string
}

/** Pending and expired invitations, newest first. Empty for members who can't manage invitations. */
export async function listOpenInvitations(organizationId: string): Promise<WorkspaceInvitation[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('organization_invitations')
    .select('id, email, role, status, expires_at, created_at')
    .eq('organization_id', organizationId)
    .in('status', ['pending', 'expired'])
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) fail('invitations', error)

  return data.flatMap((row) =>
    isOrganizationRole(row.role)
      ? [
          {
            id: row.id,
            email: row.email,
            role: row.role,
            status: effectiveInvitationStatus(row.status, row.expires_at),
            expiresAt: row.expires_at,
            createdAt: row.created_at,
          },
        ]
      : [],
  )
}

export interface CompanyDetailsRecord {
  legalName: string | null
  industry: string | null
  website: string | null
  description: string | null
  timezone: string
}

export async function getCompanyDetails(organizationId: string): Promise<CompanyDetailsRecord | null> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('company_settings')
    .select('legal_name, industry, website, description, timezone')
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) fail('company details', error)
  if (!data) return null
  return {
    legalName: data.legal_name,
    industry: data.industry,
    website: data.website,
    description: data.description,
    timezone: data.timezone,
  }
}

export async function getOnboardingFacts(
  organizationId: string,
  role: OrganizationRole,
  hasName: boolean,
): Promise<OnboardingFacts> {
  const supabase = await createUserClient()
  const [company, members, invitations] = await Promise.all([
    supabase
      .from('company_settings')
      .select('legal_name, industry, website, description')
      .eq('organization_id', organizationId)
      .maybeSingle(),
    supabase
      .from('organization_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'active'),
    canManageMembers(role)
      ? supabase
          .from('organization_invitations')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .in('status', ['pending', 'accepted'])
      : Promise.resolve({ count: 0, error: null }),
  ])
  if (company.error) fail('onboarding progress', company.error)
  if (members.error) fail('onboarding progress', members.error)
  if (invitations.error) fail('onboarding progress', invitations.error)

  const details = company.data
  return {
    role,
    hasName,
    hasCompanyDetails: Boolean(details && (details.legal_name || details.industry || details.website || details.description)),
    hasInvitedSomeone: (members.count ?? 0) > 1 || (invitations.count ?? 0) > 0,
  }
}

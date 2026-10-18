// The signed-in user and their role in a workspace, confirmed with Supabase
// Auth and read under RLS. Integration actions use the service role for
// credentials and execution state, so they check the role here first.

import 'server-only'

import { createUserClient } from '@/lib/supabase/server'
import type { OrganizationRole } from '@/lib/supabase/types'
import { isOrganizationRole } from '@/modules/app-shell/domain/workspace'
import { getVerifiedUser, type VerifiedUser } from '@/modules/identity/server/session'

export type MemberCheck = { status: 'ok'; user: VerifiedUser; role: OrganizationRole } | { status: 'signed_out' } | { status: 'not_member' }

export async function getVerifiedMember(organizationId: string): Promise<MemberCheck> {
  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  if (!user) return { status: 'signed_out' }
  const { data, error } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (error || !data || !isOrganizationRole(data.role)) return { status: 'not_member' }
  return { status: 'ok', user, role: data.role }
}

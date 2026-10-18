import type { Metadata } from 'next'

import { SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { getServerEnv } from '@/lib/env/server'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { canManageMembers, invitableRoles, ROLE_DESCRIPTIONS } from '@/modules/identity/domain/members'
import { listMembers, listOpenInvitations } from '@/modules/identity/server/queries'
import { InvitationsTable, InviteDialog } from '@/modules/identity/ui/invitations-panel'
import { MembersPanel } from '@/modules/identity/ui/members-panel'
import { SettingsTabs } from '@/modules/identity/ui/settings-tabs'
import { roleLabel } from '@/modules/app-shell/domain/workspace'
import { ORGANIZATION_ROLES } from '@/lib/supabase/types'

export const metadata: Metadata = { title: 'Members' }

export default async function MembersPage() {
  const item = getNavItem('/app/settings')
  const context = await getShellContext()
  const gate = requireWorkspace(context, 'workspace members')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    )
  }

  const { workspace, user } = gate
  const manages = canManageMembers(workspace.role)
  const [members, invitations] = await Promise.all([
    listMembers(workspace.organizationId),
    manages ? listOpenInvitations(workspace.organizationId) : Promise.resolve([]),
  ])
  const emailConfigured = Boolean(getServerEnv().email)

  return (
    <>
      <PageHeader title={item.title} description={`Who can use ${workspace.name}, and what they can do.`} />
      <SettingsTabs />
      <SectionCard
        title="Members"
        description={`${members.length} ${members.length === 1 ? 'person' : 'people'} in this workspace.`}
        action={manages ? <InviteDialog organizationId={workspace.organizationId} roles={invitableRoles(workspace.role)} /> : undefined}
      >
        <MembersPanel organizationId={workspace.organizationId} members={members} actor={{ userId: user.id, role: workspace.role }} />
      </SectionCard>
      {manages ? (
        <SectionCard
          title="Invitations"
          description={
            emailConfigured
              ? 'Invitations are emailed and expire after 7 days. Resending creates a new link and cancels the old one.'
              : 'Email isn’t set up yet, so you’ll get a link to share when you invite someone. Invitations expire after 7 days.'
          }
        >
          <InvitationsTable organizationId={workspace.organizationId} invitations={invitations} />
        </SectionCard>
      ) : null}
      <SectionCard title="Roles" description="What each role can do.">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {[...ORGANIZATION_ROLES].reverse().map((role) => (
            <div key={role} className="flex flex-col gap-0.5">
              <dt className="font-medium">{roleLabel(role)}</dt>
              <dd className="text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
    </>
  )
}

import type { Metadata } from 'next'

import { SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { roleLabel } from '@/modules/app-shell/domain/workspace'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { canDeleteWorkspace, canEditWorkspace } from '@/modules/identity/domain/members'
import { getCompanyDetails } from '@/modules/identity/server/queries'
import { SettingsTabs } from '@/modules/identity/ui/settings-tabs'
import {
  CompanyDetailsForm,
  DeleteWorkspaceButton,
  LeaveWorkspaceButton,
  WorkspaceDetailsForm,
} from '@/modules/identity/ui/workspace-forms'

export const metadata: Metadata = { title: 'Settings' }

function timeZones(): string[] {
  const zones = Intl.supportedValuesOf('timeZone')
  return zones.includes('UTC') ? zones : ['UTC', ...zones]
}

export default async function SettingsPage() {
  const item = getNavItem('/app/settings')
  const gate = requireWorkspace(await getShellContext(), 'workspace settings')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    )
  }

  const { workspace } = gate
  const editable = canEditWorkspace(workspace.role)
  const company = await getCompanyDetails(workspace.organizationId)

  return (
    <>
      <PageHeader title={item.title} description={`Settings for ${workspace.name}. You’re ${roleLabel(workspace.role).toLowerCase()} here.`} />
      <SettingsTabs />
      <SectionCard
        title="Workspace"
        description={editable ? 'The name and address everyone in this workspace sees.' : 'Only admins and owners can change these.'}
      >
        {editable ? (
          <WorkspaceDetailsForm organizationId={workspace.organizationId} name={workspace.name} slug={workspace.slug} />
        ) : (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <ReadOnly label="Name" value={workspace.name} />
            <ReadOnly label="Workspace address" value={workspace.slug} mono />
          </dl>
        )}
      </SectionCard>
      <SectionCard
        title="Company details"
        description={editable ? 'Background about your company.' : 'Only admins and owners can change these.'}
      >
        {editable ? (
          <CompanyDetailsForm
            organizationId={workspace.organizationId}
            timeZones={timeZones()}
            initial={{
              legalName: company?.legalName ?? '',
              industry: company?.industry ?? '',
              website: company?.website ?? '',
              description: company?.description ?? '',
              timezone: company?.timezone ?? 'UTC',
            }}
          />
        ) : (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <ReadOnly label="Legal company name" value={company?.legalName} />
            <ReadOnly label="Industry" value={company?.industry} />
            <ReadOnly label="Website" value={company?.website} />
            <ReadOnly label="Time zone" value={company?.timezone} />
            <div className="sm:col-span-2">
              <ReadOnly label="What your company does" value={company?.description} />
            </div>
          </dl>
        )}
      </SectionCard>
      <SectionCard
        title="Leave or delete"
        description={
          canDeleteWorkspace(workspace.role)
            ? 'Leaving removes only your access. Deleting removes the workspace and all its data for everyone.'
            : 'Leaving removes your access to this workspace.'
        }
      >
        <div className="flex flex-wrap gap-2">
          <LeaveWorkspaceButton organizationId={workspace.organizationId} name={workspace.name} />
          {canDeleteWorkspace(workspace.role) ? (
            <DeleteWorkspaceButton organizationId={workspace.organizationId} name={workspace.name} slug={workspace.slug} />
          ) : null}
        </div>
      </SectionCard>
    </>
  )
}

function ReadOnly({ label, value, mono = false }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : 'font-medium'}>{value || <span className="text-muted-foreground">Not set</span>}</dd>
    </div>
  )
}

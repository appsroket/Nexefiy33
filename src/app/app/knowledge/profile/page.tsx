import type { Metadata } from 'next'

import { SectionCard } from '@/components/cards'
import { createUserClient } from '@/lib/supabase/server'
import { describeWeeklyHours } from '@/modules/knowledge/domain/company-profile'
import { canEditCompanyProfile } from '@/modules/knowledge/domain/context-kinds'
import { getCompanyProfile } from '@/modules/knowledge/server/queries'
import { CompanyProfileForm } from '@/modules/knowledge/ui/company-profile-form'
import { KnowledgeFrame, knowledgeGate } from '@/modules/knowledge/ui/knowledge-frame'

export const metadata: Metadata = { title: 'Company profile' }

function timeZones(): string[] {
  const zones = Intl.supportedValuesOf('timeZone')
  return zones.includes('UTC') ? zones : ['UTC', ...zones]
}

export default async function CompanyProfilePage() {
  const gate = await knowledgeGate()
  if (!gate.ok) return gate.page
  const { workspace } = gate
  const profile = await getCompanyProfile(await createUserClient(), workspace.organizationId)
  const editable = canEditCompanyProfile(workspace.role)

  return (
    <KnowledgeFrame description="Who you are, when you’re open and how you sound. AI employees read this before every task.">
      <SectionCard
        title="Company profile"
        description={editable ? 'Admins and owners can change this.' : 'Only admins and owners can change this.'}
      >
        {editable ? (
          <CompanyProfileForm organizationId={workspace.organizationId} profile={profile} timeZones={timeZones()} />
        ) : (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <ReadOnly label="Legal company name" value={profile?.legalName} />
            <ReadOnly label="Industry" value={profile?.industry} />
            <ReadOnly label="Website" value={profile?.website} />
            <ReadOnly label="Time zone" value={profile?.timezone} />
            <ReadOnly label="Operating hours" value={describeWeeklyHours(profile?.settings.operatingHours?.weekly).join('\n')} />
            <ReadOnly label="Brand voice" value={profile?.brandVoice} />
            <div className="sm:col-span-2">
              <ReadOnly label="What your company does" value={profile?.description} />
            </div>
          </dl>
        )}
      </SectionCard>
    </KnowledgeFrame>
  )
}

function ReadOnly({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium whitespace-pre-line">{value || <span className="text-muted-foreground">Not set</span>}</dd>
    </div>
  )
}

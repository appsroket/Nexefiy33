import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { hasMinRole } from '@/lib/supabase/types'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { loadPolicyEditorOptions } from '@/modules/governance/server/queries'
import { PolicyEditor } from '@/modules/governance/ui/policy-editor'
import { SettingsTabs } from '@/modules/identity/ui/settings-tabs'

export const metadata: Metadata = { title: 'New policy' }

export default async function NewPolicyPage() {
  const item = getNavItem('/app/settings')
  const gate = requireWorkspace(await getShellContext(), 'governance')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    )
  }
  if (!hasMinRole(gate.workspace.role, 'admin')) redirect('/app/settings/governance')
  const options = await loadPolicyEditorOptions(gate.workspace.organizationId)
  return (
    <>
      <PageHeader title="New policy" description="Policies apply to every employee, workflow and person in this workspace as soon as they’re on." />
      <SettingsTabs />
      <SectionCard title="Policy">
        <PolicyEditor
          organizationId={gate.workspace.organizationId}
          value={{ id: null, name: '', description: '', enabled: true, priority: 100, document: { rules: [] } }}
          options={options}
          canManage
        />
      </SectionCard>
    </>
  )
}

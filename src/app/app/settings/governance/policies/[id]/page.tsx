import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { hasMinRole } from '@/lib/supabase/types'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { listPolicies, listPolicyVersions, loadPolicyEditorOptions, memberNames } from '@/modules/governance/server/queries'
import { PolicyEditor } from '@/modules/governance/ui/policy-editor'
import { SettingsTabs } from '@/modules/identity/ui/settings-tabs'

export const metadata: Metadata = { title: 'Policy' }

const CHANGE_LABELS = { created: 'Created', updated: 'Changed', deleted: 'Deleted' } as const

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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
  const { workspace } = gate
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const [policies, versions, options, names] = await Promise.all([
    listPolicies(workspace.organizationId),
    listPolicyVersions(workspace.organizationId, id),
    loadPolicyEditorOptions(workspace.organizationId),
    memberNames(workspace.organizationId),
  ])
  const policy = policies.find((candidate) => candidate.id === id)
  if (!policy) notFound()

  return (
    <>
      <PageHeader title={policy.name} description={`Revision ${policy.revision}. Changes take effect at once and are kept as a new revision.`} />
      <SettingsTabs />
      <SectionCard title="Policy">
        <PolicyEditor
          organizationId={workspace.organizationId}
          value={{ id: policy.id, name: policy.name, description: policy.description ?? '', enabled: policy.enabled, priority: policy.priority, document: policy.document }}
          options={options}
          canManage={hasMinRole(workspace.role, 'admin')}
        />
      </SectionCard>
      <SectionCard title="History" description="Every revision, who made it and with which role. Revisions can’t be changed.">
        <ol className="flex flex-col divide-y">
          {versions.map((version) => (
            <li key={version.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <p className="text-sm">
                <span className="font-medium">
                  {CHANGE_LABELS[version.change]} · revision {version.revision}
                </span>{' '}
                <span className="text-muted-foreground">
                  <DateTime value={version.createdAt} />
                  {version.changedBy ? ` by ${names.get(version.changedBy) ?? 'a former member'}` : ' by the system'}
                  {version.authorizedRole ? ` (${version.authorizedRole})` : ''} · {version.enabled ? 'on' : 'off'}
                </span>
              </p>
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Document</summary>
                <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(version.document, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      </SectionCard>
    </>
  )
}

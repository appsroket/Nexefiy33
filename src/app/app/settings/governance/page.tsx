import type { Metadata } from 'next'
import Link from 'next/link'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { hasMinRole } from '@/lib/supabase/types'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { getGovernanceState, listPolicies, memberNames } from '@/modules/governance/server/queries'
import { EmergencyStopPanel } from '@/modules/governance/ui/emergency-stop'
import { RetentionForm } from '@/modules/governance/ui/retention-form'
import { RiskTable } from '@/modules/governance/ui/risk-table'
import { SettingsTabs } from '@/modules/identity/ui/settings-tabs'

export const metadata: Metadata = { title: 'Governance' }

function policySummary(policy: Awaited<ReturnType<typeof listPolicies>>[number]): string {
  const parts = [`${policy.document.rules.length} rule${policy.document.rules.length === 1 ? '' : 's'}`]
  if (policy.document.tools?.allowlist) parts.push(`allowlist of ${policy.document.tools.allowlist.length}`)
  if (policy.document.dataAccess?.blockedSourceIds?.length) parts.push(`${policy.document.dataAccess.blockedSourceIds.length} blocked source(s)`)
  if (policy.document.dataAccess?.requireSelectedSources) parts.push('named sources only')
  if (policy.document.limits && Object.keys(policy.document.limits).length) parts.push('limits')
  if (policy.document.approvals?.separateApprover) parts.push('separate approver')
  return parts.join(' · ')
}

export default async function GovernancePage() {
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
  const admin = hasMinRole(workspace.role, 'admin')
  const [state, policies, names] = await Promise.all([getGovernanceState(workspace.organizationId), listPolicies(workspace.organizationId), memberNames(workspace.organizationId)])
  const actions = listEmployeeTools().map((tool) => ({ key: tool.key, title: tool.title, category: tool.category }))

  return (
    <>
      <PageHeader title={item.title} description="Rules for what AI employees and workflows may do, who approves it, and how to stop everything at once." />
      <SettingsTabs />
      <SectionCard title="Emergency stop" description="Stops all AI work in this workspace at once. Enforced by the database for every code path.">
        <EmergencyStopPanel
          organizationId={workspace.organizationId}
          stop={state.emergencyStop}
          stoppedBy={state.emergencyStop?.by ? (names.get(state.emergencyStop.by) ?? 'a former member') : null}
          canManage={admin}
        />
      </SectionCard>
      <SectionCard
        title="Policies"
        description="Every enabled policy applies at once and the strictest result wins. Each change is kept as a revision, with who made it."
        action={
          admin ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/app/settings/governance/policies/new">New policy</Link>
            </Button>
          ) : undefined
        }
      >
        {policies.length ? (
          <ul className="flex flex-col divide-y">
            {policies.map((policy) => (
              <li key={policy.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/app/settings/governance/policies/${policy.id}`} className="font-medium underline-offset-4 hover:underline">
                    {policy.name}
                  </Link>
                  <StatusIndicator tone={policy.enabled ? 'success' : 'neutral'} label={policy.enabled ? 'On' : 'Off'} />
                  <span className="text-xs text-muted-foreground">Revision {policy.revision}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {policySummary(policy)}. Last changed <DateTime value={policy.updatedAt} />
                  {policy.authorizedBy ? ` by ${names.get(policy.authorizedBy) ?? 'a former member'}` : ''}
                  {policy.authorizedRole ? ` (${policy.authorizedRole})` : ' — not authorized by an admin or owner, so its “allow” rules don’t waive approval'}.
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No policies yet. The defaults below apply.</p>
        )}
      </SectionCard>
      <SectionCard title="How actions are classified" description="Every action has a category; the category sets its risk tier and the approval rules for it.">
        <RiskTable actions={actions} />
      </SectionCard>
      <SectionCard
        title="Evidence retention"
        description={
          state.retention.lastPurgedAt ? (
            <>
              Leave a field empty to keep that data. The audit log is kept for at least a year regardless. Last purge: <DateTime value={state.retention.lastPurgedAt} />.
            </>
          ) : (
            'Leave a field empty to keep that data. The audit log is kept for at least a year regardless. The purge runs from the governance job (/api/cron/governance).'
          )
        }
      >
        <RetentionForm organizationId={workspace.organizationId} initial={state.retention} canManage={admin} />
      </SectionCard>
    </>
  )
}

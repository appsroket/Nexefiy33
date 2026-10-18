import { Bot, ClipboardCheck, Plug, Workflow } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { MetricCard, SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { NAV_ITEMS } from '@/modules/app-shell/domain/navigation'
import { roleLabel } from '@/modules/app-shell/domain/workspace'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { getWorkspaceSummary } from '@/modules/app-shell/server/workspace-summary'
import { NAV_ICONS } from '@/modules/app-shell/ui/nav-icons'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { onboardingProgress } from '@/modules/identity/domain/onboarding'
import { getOnboardingFacts } from '@/modules/identity/server/queries'
import { OnboardingChecklist } from '@/modules/identity/ui/onboarding-checklist'
import { CreateWorkspaceForm } from '@/modules/identity/ui/workspace-forms'

export const metadata: Metadata = { title: 'Overview' }

export default async function OverviewPage() {
  const context = await getShellContext()
  const gate = requireWorkspace(context, 'your workspace')

  if (!gate.ok) {
    if (context.status === 'signed_in' && context.workspaces.length === 0) {
      return (
        <>
          <PageHeader
            title={`Welcome${context.user.fullName ? `, ${context.user.fullName}` : ''}`}
            description="Start by creating a workspace for your company. If a teammate invited you, open the link in their invitation email instead."
          />
          <SectionCard title="Create your workspace" description="You’ll be its owner and can invite your team next.">
            <CreateWorkspaceForm />
          </SectionCard>
          <SectionsGuide />
        </>
      )
    }
    return (
      <>
        <PageHeader
          title="Overview"
          description="Nexefiy lets you set up AI employees, connect them to your business apps, and supervise their work with approvals."
        />
        {gate.fallback}
        <SectionsGuide />
      </>
    )
  }

  const { workspace, user } = gate
  const [summary, facts] = await Promise.all([
    getWorkspaceSummary(workspace.organizationId),
    getOnboardingFacts(workspace.organizationId, workspace.role, Boolean(user.fullName)),
  ])
  const progress = onboardingProgress(facts)
  const pendingApprovals = context.status === 'signed_in' ? context.notifications.total : 0
  const article = /^[aeiou]/i.test(roleLabel(workspace.role)) ? 'an' : 'a'

  return (
    <>
      <PageHeader
        title={workspace.name}
        description={`Welcome back, ${user.displayName}. You’re ${article} ${roleLabel(workspace.role).toLowerCase()} in this workspace.`}
      />
      {progress.completed < progress.total ? <OnboardingChecklist progress={progress} /> : null}
      <section aria-labelledby="summary-heading" className="flex flex-col gap-3">
        <h2 id="summary-heading" className="text-sm font-medium text-muted-foreground">
          Workspace summary
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard icon={ClipboardCheck} label="Waiting for your approval" value={pendingApprovals} />
          <MetricCard icon={Bot} label="AI employees" value={summary.employees} />
          <MetricCard icon={Workflow} label="Workflows" value={summary.workflows} />
          <MetricCard icon={Plug} label="Connected apps" value={summary.connectedApps} />
        </div>
        <p className="text-xs text-muted-foreground">
          Counts come directly from your workspace. Outcome and cost reporting will appear in Analytics once it’s
          available.
        </p>
      </section>
      <SectionsGuide />
    </>
  )
}

/** What each area of the product does, and whether it is available yet. */
function SectionsGuide() {
  return (
    <SectionCard title="Getting around" description="Every area of Nexefiy, and what you can do there.">
      <ul className="grid gap-x-6 gap-y-1 md:grid-cols-2">
        {NAV_ITEMS.filter((item) => item.href !== '/app').map((item) => {
          const Icon = NAV_ICONS[item.icon]
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className="-mx-2 flex gap-3 rounded-lg px-2 py-2.5 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {item.title}
                    {item.availability === 'planned' ? <StatusIndicator tone="neutral" label="Coming soon" /> : null}
                  </span>
                  <span className="text-sm text-muted-foreground">{item.description}</span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </SectionCard>
  )
}

import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/page-header'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { periodFromParams } from '@/modules/analytics/domain/period'
import { loadAnalytics, loadScopeNames } from '@/modules/analytics/server/queries'
import { BasisLegend, PeriodSwitcher } from '@/modules/analytics/ui/analytics-chrome'
import { ScopeDashboard } from '@/modules/analytics/ui/scope-dashboard'

export const metadata: Metadata = { title: 'Workflow analytics' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function WorkflowAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'analytics')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Workflow analytics" />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const now = new Date()
  const period = periodFromParams(await searchParams, now)
  const [report, names] = await Promise.all([loadAnalytics(workspace.organizationId, period, { includeUsage: false, now }), loadScopeNames(workspace.organizationId)])
  const name = names.workflows.get(id)
  if (!name) notFound()

  return (
    <>
      <div>
        <Link href={`/app/analytics?period=${period.key}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Analytics
        </Link>
      </div>
      <PageHeader
        title={name}
        description={
          <>
            Workflow ·{' '}
            <Link href={`/app/workflows/${id}`} className="underline underline-offset-4">
              Definition and runs
            </Link>
          </>
        }
      />
      <PeriodSwitcher basePath={`/app/analytics/workflows/${id}`} period={period} />
      <BasisLegend period={period} />
      <ScopeDashboard report={report} scope={{ grain: 'workflow', key: id, name }} />
    </>
  )
}

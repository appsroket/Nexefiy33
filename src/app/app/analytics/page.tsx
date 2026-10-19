import type { Metadata } from 'next'

import { SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { hasMinRole } from '@/lib/supabase/types'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { periodFromParams } from '@/modules/analytics/domain/period'
import { departmentLabel, loadAnalytics, loadScopeNames } from '@/modules/analytics/server/queries'
import { BasisLegend, PeriodSwitcher, TaskBreakdownTable, WorkflowBreakdownTable } from '@/modules/analytics/ui/analytics-chrome'
import { ScopeDashboard } from '@/modules/analytics/ui/scope-dashboard'

export const metadata: Metadata = { title: 'Analytics' }

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const item = getNavItem('/app/analytics')
  const gate = requireWorkspace(await getShellContext(), 'analytics')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const now = new Date()
  const period = periodFromParams(await searchParams, now)
  const [report, names] = await Promise.all([
    loadAnalytics(workspace.organizationId, period, { includeUsage: hasMinRole(workspace.role, 'admin'), now }),
    loadScopeNames(workspace.organizationId),
  ])
  const query = `?period=${period.key}`
  const departments = report.tasks
    .filter((row) => row.grain === 'department')
    .map((row) => ({ key: row.key, name: departmentLabel(row.key), href: `/app/analytics/departments/${row.key}${query}` }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const employees = report.tasks
    .filter((row) => row.grain === 'employee')
    .map((row) => ({ key: row.key, name: names.employees.get(row.key)?.name ?? 'Deleted employee', href: `/app/analytics/employees/${row.key}${query}` }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const workflows = [...new Set(report.runs.filter((row) => row.grain === 'workflow').map((row) => row.key))]
    .map((key) => ({ key, name: names.workflows.get(key) ?? 'Deleted workflow', href: `/app/analytics/workflows/${key}${query}` }))
    .sort((left, right) => left.name.localeCompare(right.name))

  return (
    <>
      <PageHeader title={item.title} description="What your AI workforce did, how reliably, with how much human help, at what model cost, and the business outcomes its actions prove." />
      <PeriodSwitcher basePath="/app/analytics" period={period} />
      <BasisLegend period={period} />
      <ScopeDashboard report={report} scope={{ grain: 'organization', key: workspace.organizationId, name: workspace.name }} />
      <SectionCard title="By department" description="The department set on the employee version that ran each task.">
        <TaskBreakdownTable report={report} grain="department" rows={departments} label="Department" />
      </SectionCard>
      <SectionCard title="By employee">
        <TaskBreakdownTable report={report} grain="employee" rows={employees} label="Employee" />
      </SectionCard>
      <SectionCard title="By workflow" description="Runs started in the period. Each workflow’s page has its run durations and the employee tasks inside its runs.">
        <WorkflowBreakdownTable report={report} rows={workflows} />
      </SectionCard>
    </>
  )
}

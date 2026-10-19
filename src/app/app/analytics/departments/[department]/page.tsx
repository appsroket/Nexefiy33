import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { periodFromParams } from '@/modules/analytics/domain/period'
import { departmentLabel, loadAnalytics, loadScopeNames } from '@/modules/analytics/server/queries'
import { BasisLegend, PeriodSwitcher, TaskBreakdownTable } from '@/modules/analytics/ui/analytics-chrome'
import { ScopeDashboard } from '@/modules/analytics/ui/scope-dashboard'
import { DEPARTMENTS } from '@/modules/employees/domain/types'

export const metadata: Metadata = { title: 'Department analytics' }

export default async function DepartmentAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ department: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { department } = await params
  if (!(DEPARTMENTS as readonly string[]).includes(department) && department !== 'unspecified') notFound()
  const name = departmentLabel(department)
  const gate = requireWorkspace(await getShellContext(), 'analytics')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={name} />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const now = new Date()
  const period = periodFromParams(await searchParams, now)
  const [report, names] = await Promise.all([loadAnalytics(workspace.organizationId, period, { includeUsage: false, now }), loadScopeNames(workspace.organizationId)])
  const employees = [...names.employees.entries()]
    .filter(([, employee]) => (employee.department ?? 'unspecified') === department)
    .map(([id, employee]) => ({ key: id, name: employee.name, href: `/app/analytics/employees/${id}?period=${period.key}` }))

  return (
    <>
      <div>
        <Link href={`/app/analytics?period=${period.key}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Analytics
        </Link>
      </div>
      <PageHeader title={`${name} department`} description="Tasks of the employee versions configured for this department, with their actions and outcomes." />
      <PeriodSwitcher basePath={`/app/analytics/departments/${department}`} period={period} />
      <BasisLegend period={period} />
      <ScopeDashboard report={report} scope={{ grain: 'department', key: department, name: `${name} department` }} />
      <SectionCard title="Employees in this department" description="Employees whose current version is in this department.">
        <TaskBreakdownTable report={report} grain="employee" rows={employees} label="Employee" />
      </SectionCard>
    </>
  )
}

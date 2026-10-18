import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { getEmployee, listTestCases, listTestRuns } from '@/modules/employees/server/queries'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { Playground } from '@/modules/employees/ui/playground'
import { isModelConfigured } from '@/modules/models/server/provider'

export const metadata: Metadata = { title: 'Test playground' }
// A test run is bounded by the employee's own time limit (at most 900 s); the
// platform's function limit applies too.
export const maxDuration = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function PlaygroundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this employee')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Test playground" />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const employee = await getEmployee(workspace.organizationId, id)
  if (!employee) notFound()
  const current = employee.versions.find((version) => version.id === employee.currentVersionId)
  const back = (
    <div>
      <Link href={`/app/employees/${employee.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {employee.name}
      </Link>
    </div>
  )
  if (!current) notFound()
  if (employee.state === 'archived') {
    return (
      <>
        {back}
        <PageHeader title={`Test ${employee.name}`} />
        <EmptyState title="Archived employees can’t be tested" description="An admin can restore it as a draft first." />
      </>
    )
  }

  const [testCases, runs] = await Promise.all([listTestCases(workspace.organizationId, employee.id), listTestRuns(workspace.organizationId, employee.id)])
  return (
    <>
      {back}
      <PageHeader
        title={`Test ${employee.name}`}
        description={`Runs use version ${current.version} (the latest saved version) with the real model. Each run counts toward the employee’s monthly budget.`}
      />
      <Playground
        organizationId={workspace.organizationId}
        employeeId={employee.id}
        currentVersionId={current.id}
        currentVersion={current.version}
        canRun={hasMinRole(workspace.role, 'operator')}
        modelConfigured={isModelConfigured()}
        testCases={testCases}
        runs={runs}
        tools={listEmployeeTools()}
      />
    </>
  )
}

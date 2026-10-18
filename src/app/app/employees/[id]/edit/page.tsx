import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { getEmployee, loadEditorOptions } from '@/modules/employees/server/queries'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { EmployeeEditor } from '@/modules/employees/ui/employee-editor'

export const metadata: Metadata = { title: 'Edit AI employee' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function EditEmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this employee')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Edit AI employee" />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const employee = await getEmployee(workspace.organizationId, id)
  if (!employee) notFound()
  const back = (
    <div>
      <Link href={`/app/employees/${employee.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {employee.name}
      </Link>
    </div>
  )
  if (!hasMinRole(workspace.role, 'operator') || employee.state === 'archived') {
    return (
      <>
        {back}
        <PageHeader title={`Edit ${employee.name}`} />
        <EmptyState
          title={employee.state === 'archived' ? 'Archived employees can’t be edited' : 'Viewers can’t edit employees'}
          description={employee.state === 'archived' ? 'An admin can restore it as a draft first.' : 'Ask an operator, admin or owner of this workspace.'}
        />
      </>
    )
  }

  const query = await searchParams
  const from = typeof query.from === 'string' ? employee.versions.find((version) => version.id === query.from) : undefined
  const current = employee.versions.find((version) => version.id === employee.currentVersionId)
  const source = from ?? current
  if (!source || !current) notFound()
  if (!source.config) {
    return (
      <>
        {back}
        <PageHeader title={`Edit ${employee.name}`} />
        <EmptyState title="This version uses an older format" description="It can’t be edited in the builder." />
      </>
    )
  }

  const options = await loadEditorOptions(workspace.organizationId)
  return (
    <>
      {back}
      <PageHeader
        title={`Edit ${employee.name}`}
        description={
          from && from.id !== current.id
            ? `Starting from version ${from.version}. Saving creates version ${current.version + 1}; earlier versions stay unchanged.`
            : `Saving creates version ${current.version + 1}. ${employee.state === 'active' || employee.state === 'paused' ? 'The active version keeps running until the new one is tested and activated.' : 'It then needs its tests run before it can be activated.'}`
        }
      />
      <EmployeeEditor
        organizationId={workspace.organizationId}
        employeeId={employee.id}
        basedOnVersionId={current.id}
        initial={{ instructions: source.instructions, config: source.config }}
        tools={listEmployeeTools()}
        connections={options.connections}
        sources={options.sources}
        skills={options.skills}
        submitLabel={`Save version ${current.version + 1}`}
      />
    </>
  )
}

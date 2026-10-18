import { Bot, Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { DateTime } from '@/components/date-time'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { hasMinRole } from '@/lib/supabase/types'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { LIFECYCLE_DISPLAY } from '@/modules/employees/domain/lifecycle'
import { DEPARTMENT_LABELS, TEST_STATUS_DISPLAY } from '@/modules/employees/domain/types'
import { listEmployees } from '@/modules/employees/server/queries'

export const metadata: Metadata = { title: 'AI employees' }

export default async function EmployeesPage() {
  const item = getNavItem('/app/employees')
  const gate = requireWorkspace(await getShellContext(), 'AI employees')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const canCreate = hasMinRole(workspace.role, 'operator')
  const employees = await listEmployees(workspace.organizationId)
  const newButton = canCreate ? (
    <Button asChild>
      <Link href="/app/employees/new">
        <Plus data-icon="inline-start" aria-hidden="true" />
        New employee
      </Link>
    </Button>
  ) : null

  return (
    <>
      <PageHeader title={item.title} description={item.description} actions={newButton} />
      <p className="max-w-2xl text-sm text-muted-foreground">
        Every employee runs on the same runtime and can use only the tools it is granted. A new employee starts as a draft; it is tested in the
        playground and an admin activates a version once its tests pass. Giving active employees work (tasks, workflows, chat) arrives in a later
        release.
      </p>
      {employees.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Latest version</TableHead>
              <TableHead>Tests</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {employees.map((employee) => {
              const state = LIFECYCLE_DISPLAY[employee.state] ?? LIFECYCLE_DISPLAY.draft
              const tests = TEST_STATUS_DISPLAY[employee.testStatus]
              return (
                <TableRow key={employee.id}>
                  <TableCell>
                    <Link href={`/app/employees/${employee.id}`} className="font-medium underline-offset-4 hover:underline">
                      {employee.name}
                    </Link>
                    {employee.description ? <p className="max-w-md truncate text-xs text-muted-foreground">{employee.description}</p> : null}
                  </TableCell>
                  <TableCell>{DEPARTMENT_LABELS[employee.department] ?? employee.department}</TableCell>
                  <TableCell>
                    <StatusIndicator tone={state.tone} label={state.label} />
                  </TableCell>
                  <TableCell>
                    {employee.currentVersion ? `v${employee.currentVersion}` : '—'}
                    {employee.activeVersion && employee.activeVersion !== employee.currentVersion ? (
                      <span className="text-xs text-muted-foreground"> (v{employee.activeVersion} active)</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusIndicator tone={tests.tone} label={tests.label} />
                  </TableCell>
                  <TableCell>
                    <DateTime value={employee.updatedAt} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          icon={Bot}
          title="No AI employees yet"
          description={canCreate ? 'Describe the employee you need, or start from a template.' : 'An operator or admin can create the first employee.'}
          action={newButton}
        />
      )}
    </>
  )
}

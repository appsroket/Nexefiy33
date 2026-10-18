import { ListChecks } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { DateTime } from '@/components/date-time'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { ACTIVE_TASK_STATUSES, TASK_STATUS_DISPLAY, VERIFICATION_DISPLAY } from '@/modules/tasks/domain/labels'
import { listTasks } from '@/modules/tasks/server/queries'
import { AutoRefresh } from '@/modules/tasks/ui/task-controls'

export const metadata: Metadata = { title: 'Tasks' }

export default async function TasksPage() {
  const item = getNavItem('/app/tasks')
  const gate = requireWorkspace(await getShellContext(), 'tasks')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    )
  }
  const tasks = await listTasks(gate.workspace.organizationId)

  return (
    <>
      <PageHeader title={item.title} description={item.description} />
      <AutoRefresh active={tasks.some((task) => ACTIVE_TASK_STATUSES.includes(task.status))} intervalMs={8000} />
      {tasks.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Employee</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Verification</TableHead>
              <TableHead>Assigned</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => (
              <TableRow key={task.id}>
                <TableCell className="max-w-md">
                  <Link href={`/app/tasks/${task.id}`} className="font-medium underline-offset-4 hover:underline">
                    {task.title}
                  </Link>
                </TableCell>
                <TableCell>
                  {task.employeeId ? (
                    <Link href={`/app/employees/${task.employeeId}`} className="underline-offset-4 hover:underline">
                      {task.employeeName ?? 'Employee'}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <StatusIndicator tone={TASK_STATUS_DISPLAY[task.status].tone} label={TASK_STATUS_DISPLAY[task.status].label} />
                </TableCell>
                <TableCell>
                  {task.verification ? (
                    <StatusIndicator tone={VERIFICATION_DISPLAY[task.verification].tone} label={VERIFICATION_DISPLAY[task.verification].label} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <DateTime value={task.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          icon={ListChecks}
          title="No tasks yet"
          description="Open an active AI employee and assign it a task. Each task shows every step, action, approval and piece of evidence."
          action={
            <Link href="/app/employees" className="text-sm font-medium underline-offset-4 hover:underline">
              Go to AI employees
            </Link>
          }
        />
      )}
    </>
  )
}

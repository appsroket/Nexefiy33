import { ListChecks, SearchX } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { DataTable, type DataTableColumn } from '@/components/data-table'
import { DateTime } from '@/components/date-time'
import { EmptyState } from '@/components/empty-state'
import { FilterBar } from '@/components/filter-bar'
import { ListPagination } from '@/components/list-pagination'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { listHref, parseListParams, type SearchParams } from '@/lib/list-params'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { formatUsd } from '@/modules/models/domain/catalog'
import { FAILURE_CLASSES } from '@/modules/tasks/domain/failures'
import { ACTIVE_TASK_STATUSES, FAILURE_CLASS_LABELS, TASK_STATUSES, TASK_STATUS_DISPLAY, VERIFICATION_DISPLAY } from '@/modules/tasks/domain/labels'
import { formatDuration, priorityLabel, TASK_LIST_SPEC, TASK_PERIOD_LABELS, TASK_PERIODS, uuidParam } from '@/modules/tasks/domain/task-center'
import { listTaskFilterOptions, listTasks, type TaskListItem } from '@/modules/tasks/server/queries'
import { AutoRefresh } from '@/modules/tasks/ui/task-controls'

export const metadata: Metadata = { title: 'Tasks' }

const PATH = '/app/tasks'

const COLUMNS: DataTableColumn<TaskListItem>[] = [
  {
    id: 'title',
    header: 'Task',
    cell: (row) => (
      <Link href={`${PATH}/${row.id}`} className="line-clamp-2 min-w-48 font-medium underline-offset-4 hover:underline">
        {row.title}
      </Link>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: (row) => (
      <span className="flex flex-col gap-1">
        <StatusIndicator tone={TASK_STATUS_DISPLAY[row.status].tone} label={TASK_STATUS_DISPLAY[row.status].label} />
        {row.failure ? <span className="text-xs text-muted-foreground">{FAILURE_CLASS_LABELS[row.failure.class] ?? row.failure.class}</span> : null}
        {row.verification ? <span className="text-xs text-muted-foreground">{VERIFICATION_DISPLAY[row.verification].label}</span> : null}
      </span>
    ),
  },
  {
    id: 'employee',
    header: 'Assigned to',
    hideBelow: 'md',
    cell: (row) => (
      <span className="flex flex-col gap-1">
        {row.employeeId ? (
          <Link href={`/app/employees/${row.employeeId}`} className="underline-offset-4 hover:underline">
            {row.employeeName ?? 'Employee'}
          </Link>
        ) : (
          '—'
        )}
        {row.workflowName ? <span className="text-xs text-muted-foreground">Workflow: {row.workflowName}</span> : null}
      </span>
    ),
  },
  { id: 'priority', header: 'Priority', sortable: true, hideBelow: 'lg', cell: (row) => priorityLabel(row.priority) },
  { id: 'created_at', header: 'Assigned', sortable: true, hideBelow: 'sm', cell: (row) => <DateTime value={row.createdAt} /> },
  {
    id: 'completed_at',
    header: 'Finished',
    sortable: true,
    hideBelow: 'lg',
    cell: (row) => (row.completedAt ? <DateTime value={row.completedAt} /> : <span className="text-muted-foreground">—</span>),
  },
  { id: 'duration', header: 'Duration', hideBelow: 'lg', cell: (row) => (row.durationMs === null ? '—' : formatDuration(row.durationMs)) },
  { id: 'cost', header: 'Model cost', hideBelow: 'md', cell: (row) => formatUsd(row.costMicros) },
]

export default async function TasksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const item = getNavItem(PATH)
  const header = (
    <PageHeader
      title="Task Center"
      description={`${item.description} Filter by status, employee, workflow, date or failure type; open a task for every step, action, approval, cost and result.`}
    />
  )
  const gate = requireWorkspace(await getShellContext(), 'tasks')
  if (!gate.ok) {
    return (
      <>
        {header}
        {gate.fallback}
      </>
    )
  }

  const params = await searchParams
  const list = parseListParams(params, TASK_LIST_SPEC)
  const employeeId = uuidParam(params, 'employee')
  const workflowId = uuidParam(params, 'workflow')
  const organizationId = gate.workspace.organizationId
  const [{ items, total }, options] = await Promise.all([listTasks(organizationId, list, { employeeId, workflowId }), listTaskFilterOptions(organizationId)])
  const filtered = Boolean(list.q || list.filters.status || list.filters.failure || list.filters.period || employeeId || workflowId)

  return (
    <>
      {header}
      <AutoRefresh active={items.some((task) => ACTIVE_TASK_STATUSES.includes(task.status))} intervalMs={8000} />
      <FilterBar
        searchLabel="Search tasks"
        searchPlaceholder="Search by title…"
        filters={[
          { param: 'status', label: 'Status', allLabel: 'All statuses', options: TASK_STATUSES.map((status) => ({ value: status, label: TASK_STATUS_DISPLAY[status].label })) },
          { param: 'employee', label: 'Employee', allLabel: 'All employees', options: options.employees.map((employee) => ({ value: employee.id, label: employee.name })) },
          { param: 'workflow', label: 'Workflow', allLabel: 'All workflows', options: options.workflows.map((workflow) => ({ value: workflow.id, label: workflow.name })) },
          { param: 'period', label: 'Assigned', allLabel: 'Any time', options: TASK_PERIODS.map((period) => ({ value: period, label: TASK_PERIOD_LABELS[period] })) },
          { param: 'failure', label: 'Failure type', allLabel: 'Any failure type', options: FAILURE_CLASSES.map((failure) => ({ value: failure, label: FAILURE_CLASS_LABELS[failure] })) },
        ]}
      />
      <DataTable
        caption="Tasks"
        columns={COLUMNS}
        rows={items}
        getRowId={(row) => row.id}
        sort={list.sort}
        sortHref={(column, direction) => listHref(PATH, params, { sort: column, dir: direction })}
        emptyState={
          filtered ? (
            <EmptyState icon={SearchX} title="No matching tasks" description="Try a different search or clear the filters." />
          ) : (
            <EmptyState
              icon={ListChecks}
              title="No tasks yet"
              description="Open an active AI employee and assign it a task. Each task shows every step, action, approval, cost and piece of evidence."
              action={
                <Link href="/app/employees" className="text-sm font-medium underline-offset-4 hover:underline">
                  Go to AI employees
                </Link>
              }
            />
          )
        }
      />
      {total > 0 ? (
        <ListPagination page={list.page} pageSize={list.pageSize} total={total} itemLabel="tasks" hrefForPage={(page) => listHref(PATH, params, { page })} />
      ) : null}
    </>
  )
}

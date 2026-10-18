// Component gallery for development and preview builds only. Everything on
// this page uses clearly labelled example data and example actions that
// store nothing. Production builds return 404.

import { Bot, Inbox, Trash2 } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { MetricCard, SectionCard } from '@/components/cards'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/data-table'
import { DateTime } from '@/components/date-time'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { FilterBar } from '@/components/filter-bar'
import { ListPagination } from '@/components/list-pagination'
import { CardGridSkeleton, TableSkeleton } from '@/components/loading-states'
import { PageHeader } from '@/components/page-header'
import { StatusBadge, StatusIndicator } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getServerEnv } from '@/lib/env/server'
import { listHref, parseListParams, type SearchParams } from '@/lib/list-params'
import { STATUS_DISPLAY, statusDisplay, type StatusKind } from '@/lib/status'
import { AccountMenu } from '@/modules/app-shell/ui/account-menu'
import { NotificationsMenu } from '@/modules/app-shell/ui/notifications-menu'

import { exampleConfirmAction, exampleFailingConfirmAction } from './actions'
import { ExampleFormDialog, ExampleInlineForm } from './example-form'

export const metadata: Metadata = { title: 'Component gallery' }

const PATH = '/app/dev/components'

interface ExampleRow {
  id: string
  name: string
  status: keyof typeof STATUS_DISPLAY.task
  updatedAt: string
}

const TASK_STATUSES = Object.keys(STATUS_DISPLAY.task) as ExampleRow['status'][]

// Fixed timestamps so the gallery renders identically on every load.
const EXAMPLE_ROWS: ExampleRow[] = Array.from({ length: 23 }, (_, i) => ({
  id: `example-${i + 1}`,
  name: `Example record ${i + 1}`,
  status: TASK_STATUSES[i % TASK_STATUSES.length]!,
  updatedAt: new Date(Date.UTC(2026, 9, 1 + (i % 15), 9 + (i % 8), (i * 7) % 60)).toISOString(),
}))

const LIST_SPEC = {
  sortable: ['name', 'updated_at'],
  defaultSort: { column: 'updated_at', direction: 'desc' },
  filters: { status: TASK_STATUSES },
  pageSize: 8,
} as const

const COLUMNS: DataTableColumn<ExampleRow>[] = [
  { id: 'name', header: 'Name', sortable: true, cell: (row) => row.name },
  { id: 'status', header: 'Status', cell: (row) => <StatusBadge kind="task" status={row.status} /> },
  { id: 'updated_at', header: 'Last updated', sortable: true, hideBelow: 'sm', cell: (row) => <DateTime value={row.updatedAt} /> },
]

export default async function ComponentGalleryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (getServerEnv().appEnv === 'production') notFound()

  const params = await searchParams
  const list = parseListParams(params, LIST_SPEC)
  const matching = EXAMPLE_ROWS.filter(
    (row) =>
      (!list.q || row.name.toLowerCase().includes(list.q.toLowerCase())) &&
      (!list.filters.status || row.status === list.filters.status),
  ).sort((a, b) => {
    const order =
      list.sort.column === 'name'
        ? a.name.localeCompare(b.name, 'en', { numeric: true })
        : a.updatedAt.localeCompare(b.updatedAt)
    return list.sort.direction === 'asc' ? order : -order
  })
  const pageRows = matching.slice(list.from, list.to + 1)

  return (
    <>
      <PageHeader
        title="Component gallery"
        description="Reusable interface components with example data. Only available in development and preview builds."
        actions={<Badge variant="secondary">Example data</Badge>}
      />

      <SectionCard title="Status indicators" description="Every status in the database, with its plain-language label.">
        <div className="flex flex-col gap-4">
          {(Object.keys(STATUS_DISPLAY) as StatusKind[]).map((kind) => (
            <div key={kind} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">{kind}</h3>
              <div className="flex flex-wrap gap-2">
                {Object.keys(STATUS_DISPLAY[kind]).map((status) => (
                  <StatusBadge key={status} kind={kind} status={status} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <StatusIndicator tone="neutral" label="Coming soon" />
            <StatusBadge kind="task" status="some_future_status" />
          </div>
        </div>
      </SectionCard>

      <section aria-labelledby="cards-heading" className="flex flex-col gap-3">
        <h2 id="cards-heading" className="text-base font-semibold">
          Cards
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard icon={Bot} label="Example count" value={12} description="A value from the database." />
          <MetricCard label="Example without data" value={null} description="Shown until real data exists." />
          <MetricCard label="Example zero" value={0} />
          <MetricCard label="Example custom empty text" value={null} emptyText="Not measured yet" />
        </div>
      </section>

      <section aria-labelledby="table-heading" className="flex flex-col gap-3">
        <h2 id="table-heading" className="text-base font-semibold">
          Table, filters and pagination
        </h2>
        <FilterBar
          searchLabel="Search examples"
          searchPlaceholder="Try “record 1”…"
          filters={[
            {
              param: 'status',
              label: 'Status',
              allLabel: 'All statuses',
              options: TASK_STATUSES.map((status) => ({ value: status, label: statusDisplay('task', status).label })),
            },
          ]}
        />
        <DataTable
          caption="Example records"
          columns={COLUMNS}
          rows={pageRows}
          getRowId={(row) => row.id}
          sort={list.sort}
          sortHref={(column, direction) => listHref(PATH, params, { sort: column, dir: direction })}
          emptyState={<EmptyState title="No matching examples" description="Try a different search or clear the filters." />}
        />
        <ListPagination
          page={list.page}
          pageSize={list.pageSize}
          total={matching.length}
          itemLabel="example records"
          hrefForPage={(page) => listHref(PATH, params, { page })}
        />
      </section>

      <SectionCard title="Forms" description="Server-validated form with inline errors, inline and in a dialog.">
        <div className="flex flex-col gap-6">
          <ExampleInlineForm />
          <div>
            <ExampleFormDialog />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Confirmation dialogs" description="Ask before actions that are hard to undo.">
        <div className="flex flex-wrap gap-2">
          <ConfirmDialog
            trigger={<Button variant="outline">Confirm (succeeds)</Button>}
            title="Run the example action?"
            description="This example action doesn’t change anything."
            confirmLabel="Run example"
            onConfirm={exampleConfirmAction}
          />
          <ConfirmDialog
            trigger={
              <Button variant="destructive">
                <Trash2 aria-hidden="true" data-icon="inline-start" />
                Delete (fails)
              </Button>
            }
            title="Delete the example record?"
            description="In a real dialog this would explain exactly what is deleted. This example fails on purpose and deletes nothing."
            confirmLabel="Delete"
            pendingLabel="Deleting…"
            destructive
            onConfirm={exampleFailingConfirmAction}
          />
        </div>
      </SectionCard>

      <section aria-labelledby="states-heading" className="flex flex-col gap-3">
        <h2 id="states-heading" className="text-base font-semibold">
          Empty, error and loading states
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <EmptyState
            headingLevel={3}
            icon={Inbox}
            title="Nothing here yet"
            description="Explains what would appear here and how to get started."
            action={<Button variant="outline">Example action</Button>}
          />
          <ErrorState headingLevel={2} reference="example-digest-1234" actions={<Button variant="outline">Try again</Button>} />
        </div>
        <CardGridSkeleton />
        <TableSkeleton rows={3} />
      </section>

      <SectionCard title="Header menus" description="Preview mode: the real header uses the signed-in user’s data.">
        <div className="flex flex-wrap items-center gap-2">
          <NotificationsMenu
            signedIn
            total={2}
            items={[
              {
                id: 'example-1',
                kind: 'approval',
                title: 'Example: send a follow-up email to an example customer',
                href: PATH,
                createdAt: '2026-10-17T09:00:00.000Z',
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
              {
                id: 'example-2',
                kind: 'approval',
                title: 'Example: update a deal stage in the CRM',
                href: PATH,
                createdAt: '2026-10-17T08:00:00.000Z',
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
            ]}
          />
          <NotificationsMenu signedIn items={[]} total={0} />
          <AccountMenu
            preview
            user={{ id: 'example', email: 'person@example.com', fullName: 'Example Person', displayName: 'Example Person', avatarUrl: null }}
            activeWorkspace={{ organizationId: 'example', name: 'Example Workspace', slug: 'example', role: 'admin' }}
          />
          <AccountMenu preview user={null} activeWorkspace={null} />
        </div>
      </SectionCard>
    </>
  )
}

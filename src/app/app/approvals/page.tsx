import { ClipboardCheck, SearchX } from 'lucide-react'
import type { Metadata } from 'next'

import { DataTable, type DataTableColumn } from '@/components/data-table'
import { DateTime } from '@/components/date-time'
import { EmptyState } from '@/components/empty-state'
import { FilterBar } from '@/components/filter-bar'
import { ListPagination } from '@/components/list-pagination'
import { PageHeader } from '@/components/page-header'
import { StatusBadge } from '@/components/status-badge'
import { listHref, parseListParams, type SearchParams } from '@/lib/list-params'
import { statusDisplay } from '@/lib/status'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { isOrganizationRole, roleLabel } from '@/modules/app-shell/domain/workspace'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { APPROVAL_LIST_SPEC, APPROVAL_STATUSES } from '@/modules/governance/domain/approvals'
import { listApprovalRequests, type ApprovalListItem } from '@/modules/governance/server/approvals'

export const metadata: Metadata = { title: 'Approvals' }

const PATH = '/app/approvals'

const COLUMNS: DataTableColumn<ApprovalListItem>[] = [
  { id: 'action', header: 'Request', cell: (row) => <span className="line-clamp-2 min-w-48">{row.actionSummary}</span> },
  { id: 'status', header: 'Status', cell: (row) => <StatusBadge kind="approval" status={row.status} /> },
  {
    id: 'required_role',
    header: 'Who can decide',
    hideBelow: 'md',
    cell: (row) => (isOrganizationRole(row.requiredRole) ? `${roleLabel(row.requiredRole)} or above` : row.requiredRole),
  },
  { id: 'created_at', header: 'Requested', sortable: true, hideBelow: 'sm', cell: (row) => <DateTime value={row.createdAt} /> },
  { id: 'expires_at', header: 'Expires', sortable: true, hideBelow: 'lg', cell: (row) => <DateTime value={row.expiresAt} /> },
]

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const item = getNavItem(PATH)
  const header = (
    <PageHeader
      title={item.title}
      description={`${item.description} Approving and rejecting from this page isn’t available yet; for now you can review what’s waiting.`}
    />
  )

  const gate = requireWorkspace(await getShellContext(), 'approval requests')
  if (!gate.ok) {
    return (
      <>
        {header}
        {gate.fallback}
      </>
    )
  }

  const params = await searchParams
  const list = parseListParams(params, APPROVAL_LIST_SPEC)
  const { items, total } = await listApprovalRequests(gate.workspace.organizationId, list)
  const filtered = Boolean(list.q || list.filters.status)

  return (
    <>
      {header}
      <FilterBar
        searchLabel="Search requests"
        searchPlaceholder="Search by description…"
        filters={[
          {
            param: 'status',
            label: 'Status',
            allLabel: 'All statuses',
            options: APPROVAL_STATUSES.map((status) => ({ value: status, label: statusDisplay('approval', status).label })),
          },
        ]}
      />
      <DataTable
        caption="Approval requests"
        columns={COLUMNS}
        rows={items}
        getRowId={(row) => row.id}
        sort={list.sort}
        sortHref={(column, direction) => listHref(PATH, params, { sort: column, dir: direction })}
        emptyState={
          filtered ? (
            <EmptyState
              icon={SearchX}
              title="No matching requests"
              description="Try a different search or clear the filters."
            />
          ) : (
            <EmptyState
              icon={ClipboardCheck}
              title="No approval requests"
              description="When an AI employee wants to take an action that needs sign-off, such as sending an email, the request will appear here."
            />
          )
        }
      />
      {total > 0 ? (
        <ListPagination
          page={list.page}
          pageSize={list.pageSize}
          total={total}
          itemLabel="requests"
          hrefForPage={(page) => listHref(PATH, params, { page })}
        />
      ) : null}
    </>
  )
}

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import Link from 'next/link'
import { useId, type ReactNode } from 'react'

import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { SortDirection } from '@/lib/list-params'
import { cn } from '@/lib/utils'

export interface DataTableColumn<Row> {
  id: string
  header: string
  cell: (row: Row) => ReactNode
  sortable?: boolean
  align?: 'start' | 'end'
  /** Hide on narrow screens; keep the most important columns visible. */
  hideBelow?: 'sm' | 'md' | 'lg'
  className?: string
}

const HIDE_BELOW = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const

/**
 * Server-rendered table. Sorting is link-based (sortHref builds the URL), so
 * it works without JavaScript and the server applies the sort in its query.
 * The first column is the row header for screen readers.
 */
export function DataTable<Row>({
  caption,
  showCaption = false,
  columns,
  rows,
  getRowId,
  sort,
  sortHref,
  emptyState,
  className,
}: {
  /** Accessible name of the table; visually hidden unless showCaption. */
  caption: string
  showCaption?: boolean
  columns: readonly DataTableColumn<Row>[]
  rows: readonly Row[]
  getRowId: (row: Row) => string
  sort?: { column: string; direction: SortDirection }
  sortHref?: (column: string, direction: SortDirection) => string
  /** Rendered instead of the table when there are no rows. */
  emptyState?: ReactNode
  className?: string
}) {
  const captionId = useId()
  if (rows.length === 0 && emptyState) return <>{emptyState}</>

  return (
    <div
      role="region"
      aria-labelledby={captionId}
      // Focusable so keyboard users can scroll wide tables horizontally.
      tabIndex={0}
      className={cn(
        'relative w-full overflow-x-auto rounded-xl border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      <table data-slot="table" className="w-full caption-bottom text-sm">
        <caption id={captionId} className={showCaption ? 'mt-4 pb-3 text-sm text-muted-foreground' : 'sr-only'}>
          {caption}
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => {
              const active = sort?.column === column.id
              const ariaSort = column.sortable ? (active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined
              return (
                <TableHead
                  key={column.id}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn(
                    'px-4 text-muted-foreground',
                    column.align === 'end' && 'text-right',
                    column.hideBelow && HIDE_BELOW[column.hideBelow],
                    column.className,
                  )}
                >
                  {column.sortable && sortHref ? (
                    <SortLink
                      label={column.header}
                      href={sortHref(column.id, active && sort.direction === 'asc' ? 'desc' : 'asc')}
                      direction={active ? sort.direction : undefined}
                    />
                  ) : (
                    column.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={getRowId(row)}>
              {columns.map((column, index) => {
                const cellClass = cn(
                  'px-4 py-3',
                  column.align === 'end' && 'text-right',
                  column.hideBelow && HIDE_BELOW[column.hideBelow],
                  column.className,
                )
                return index === 0 ? (
                  <th key={column.id} scope="row" className={cn('text-left align-middle font-medium', cellClass)}>
                    {column.cell(row)}
                  </th>
                ) : (
                  <TableCell key={column.id} className={cellClass}>
                    {column.cell(row)}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </table>
    </div>
  )
}

function SortLink({ label, href, direction }: { label: string; href: string; direction?: SortDirection }) {
  const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown
  const next = direction === 'asc' ? 'descending' : 'ascending'
  return (
    <Link
      href={href}
      scroll={false}
      className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {label}
      <Icon aria-hidden="true" className={cn('size-3.5', !direction && 'opacity-50')} />
      <span className="sr-only">, sort {next}</span>
    </Link>
  )
}

import { ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { pageCount } from '@/lib/list-params'

/** Previous/next paging for server-rendered lists, with a live range summary. */
export function ListPagination({
  page,
  pageSize,
  total,
  hrefForPage,
  itemLabel = 'items',
}: {
  page: number
  pageSize: number
  total: number
  hrefForPage: (page: number) => string
  itemLabel?: string
}) {
  const pages = pageCount(total, pageSize)
  const current = Math.min(page, pages)
  const start = total === 0 ? 0 : (current - 1) * pageSize + 1
  const end = Math.min(current * pageSize, total)

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p aria-live="polite" className="text-muted-foreground">
        {total === 0 ? `No ${itemLabel}` : `Showing ${start}–${end} of ${total} ${itemLabel}`}
      </p>
      {pages > 1 ? (
        <div className="flex items-center gap-2">
          <PageButton href={current > 1 ? hrefForPage(current - 1) : undefined} label="Previous page">
            <ChevronLeft aria-hidden="true" data-icon="inline-start" />
            Previous
          </PageButton>
          <span className="text-muted-foreground tabular-nums">
            Page {current} of {pages}
          </span>
          <PageButton href={current < pages ? hrefForPage(current + 1) : undefined} label="Next page">
            Next
            <ChevronRight aria-hidden="true" data-icon="inline-end" />
          </PageButton>
        </div>
      ) : null}
    </nav>
  )
}

function PageButton({ href, label, children }: { href?: string; label: string; children: React.ReactNode }) {
  if (!href) {
    return (
      <Button variant="outline" size="sm" disabled aria-label={label}>
        {children}
      </Button>
    )
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href} aria-label={label} scroll={false}>
        {children}
      </Link>
    </Button>
  )
}

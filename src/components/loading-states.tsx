import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Announces loading to screen readers once; the skeleton shapes are decorative. */
function LoadingRegion({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  )
}

export function TableSkeleton({ rows = 5, columns = 4, className }: { rows?: number; columns?: number; className?: string }) {
  return (
    <LoadingRegion label="Loading table…" className={cn('overflow-hidden rounded-xl border bg-card', className)}>
      <div className="flex gap-4 border-b px-4 py-3">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-4 border-b px-4 py-3 last:border-b-0">
          {Array.from({ length: columns }, (_, i) => (
            <Skeleton key={i} className={cn('h-4 flex-1', i === 0 && 'flex-[2]')} />
          ))}
        </div>
      ))}
    </LoadingRegion>
  )
}

export function CardGridSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <LoadingRegion label="Loading…" className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </LoadingRegion>
  )
}

/** Default page-level fallback used by loading.tsx files. */
export function PageSkeleton() {
  return (
    <LoadingRegion label="Loading page…" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <CardGridSkeleton />
      <TableSkeleton />
    </LoadingRegion>
  )
}

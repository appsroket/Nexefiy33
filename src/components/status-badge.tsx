import { statusDisplay, type StatusKind, type StatusTone } from '@/lib/status'
import { cn } from '@/lib/utils'

const DOT_CLASS: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
}

/**
 * Status pill: a coloured dot plus a text label, so meaning never depends on
 * colour alone. Text stays in the foreground colour for contrast.
 */
export function StatusIndicator({
  tone,
  label,
  className,
}: {
  tone: StatusTone
  label: string
  className?: string
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border bg-background px-2 text-xs font-medium whitespace-nowrap text-foreground',
        className,
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[tone])} />
      {label}
    </span>
  )
}

/** Status of a database record, using the shared labels in @/lib/status. */
export function StatusBadge({ kind, status, className }: { kind: StatusKind; status: string; className?: string }) {
  const { label, tone } = statusDisplay(kind, status)
  return <StatusIndicator tone={tone} label={label} className={className} />
}

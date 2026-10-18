import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** A titled block of related content on a page. */
export function SectionCard({
  title,
  description,
  action,
  footer,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">{title}</h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </Card>
  )
}

/**
 * One number with its label. `value` is null until real data exists; the
 * card then says so instead of showing a zero or an invented figure.
 */
export function MetricCard({
  label,
  value,
  description,
  icon: Icon,
  emptyText = 'No data yet',
  className,
}: {
  label: string
  value: string | number | null
  description?: ReactNode
  icon?: LucideIcon
  emptyText?: string
  className?: string
}) {
  const hasValue = value !== null
  return (
    <Card size="sm" className={cn('gap-2', className)}>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {Icon ? <Icon aria-hidden="true" className="size-4" /> : null}
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {hasValue ? (
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
        ) : (
          <p className="text-sm font-medium text-muted-foreground">{emptyText}</p>
        )}
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </CardContent>
    </Card>
  )
}

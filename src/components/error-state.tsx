import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { cn } from '@/lib/utils'

/**
 * Something failed. Never shows raw error messages or stack traces: only a
 * plain explanation, recovery actions, and a reference code support can use
 * to find the server log entry.
 */
export function ErrorState({
  title = 'Something went wrong',
  description = 'This part of the page couldn’t be loaded. Your data is safe. Try again, and if the problem continues, contact support.',
  reference,
  actions,
  className,
  headingLevel = 2,
}: {
  title?: string
  description?: ReactNode
  /** Error digest from Next.js, safe to show. */
  reference?: string
  actions?: ReactNode
  className?: string
  headingLevel?: 1 | 2
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  return (
    <Empty role="alert" className={cn('border border-destructive/30 bg-card', className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
          <CircleAlert aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <Heading className="text-base font-medium">{title}</Heading>
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
        {reference ? (
          <p className="text-xs text-muted-foreground">
            Reference: <code className="font-mono">{reference}</code>
          </p>
        ) : null}
      </EmptyHeader>
      {actions ? <EmptyContent className="flex-row flex-wrap justify-center">{actions}</EmptyContent> : null}
    </Empty>
  )
}

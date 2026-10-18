// Building blocks shared by every public page. Server Components only.

import Link from 'next/link'
import type { ReactNode } from 'react'

import { StatusIndicator } from '@/components/status-badge'
import { cn } from '@/lib/utils'

import { CAPABILITY_STATUS, STATUS_ORDER, type CapabilityStatus } from '../domain/capabilities'

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8', className)}>{children}</div>
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <svg aria-hidden="true" viewBox="0 0 32 32" className="size-7 shrink-0">
        <rect width="32" height="32" rx="8" className="fill-primary" />
        <path d="M10 23V9h2.6l6.8 9.4V9H22v14h-2.6l-6.8-9.4V23z" className="fill-primary-foreground" />
      </svg>
      Nexefiy
    </span>
  )
}

/** Introduction at the top of a page: its single <h1>, a lead paragraph, and actions. */
export function PageIntro({
  eyebrow,
  title,
  lead,
  actions,
  children,
}: {
  eyebrow?: string
  title: string
  lead: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="border-b bg-gradient-to-b from-primary/5 to-transparent">
      <Container className="flex flex-col gap-5 py-14 sm:py-20">
        {eyebrow ? <p className="text-sm font-medium text-primary">{eyebrow}</p> : null}
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl">{title}</h1>
        <div className="max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">{lead}</div>
        {actions ? <div className="flex flex-wrap gap-3 pt-2">{actions}</div> : null}
        {children}
      </Container>
    </div>
  )
}

/** A titled page section; the heading labels the region for assistive technology. */
export function Section({
  id,
  title,
  description,
  children,
  className,
  tone = 'plain',
}: {
  id: string
  title: string
  description?: ReactNode
  children: ReactNode
  className?: string
  tone?: 'plain' | 'muted'
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className={cn('scroll-mt-20 py-14 sm:py-20', tone === 'muted' && 'border-y bg-muted/40', className)}
    >
      <Container className="flex flex-col gap-8">
        <div className="flex max-w-3xl flex-col gap-3">
          <h2 id={`${id}-heading`} className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            {title}
          </h2>
          {description ? <div className="text-pretty text-muted-foreground">{description}</div> : null}
        </div>
        {children}
      </Container>
    </section>
  )
}

export function CapabilityStatusBadge({ status, className }: { status: CapabilityStatus; className?: string }) {
  const { label, tone } = CAPABILITY_STATUS[status]
  return <StatusIndicator tone={tone} label={label} className={className} />
}

/** Explains the status labels; shown wherever statuses appear. */
export function StatusLegend({ className }: { className?: string }) {
  return (
    <dl className={cn('grid gap-3 rounded-xl border bg-card p-4 text-sm sm:grid-cols-3', className)}>
      {STATUS_ORDER.map((status) => (
        <div key={status} className="flex flex-col gap-1.5">
          <dt>
            <CapabilityStatusBadge status={status} />
          </dt>
          <dd className="text-muted-foreground">{CAPABILITY_STATUS[status].description}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Inline text link in body copy. */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-primary underline-offset-4 hover:underline">
      {children}
    </Link>
  )
}

/** A visible "this is an example" marker for illustrative content. */
export function IllustrativeNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">Illustrative: </span>
      {children}
    </p>
  )
}

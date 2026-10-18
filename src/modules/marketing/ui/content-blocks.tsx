// Content blocks rendered from the marketing domain data.

import {
  BarChart3,
  Briefcase,
  CalendarClock,
  Headset,
  Megaphone,
  Phone,
  Settings2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { CAPABILITY_AREAS, CAPABILITIES, STATUS_ORDER, type CapabilityArea } from '../domain/capabilities'
import type { EmployeeCategory, EmployeeIcon } from '../domain/employees'
import { EARLY_ACCESS_HREF, PUBLIC_PAGES } from '../domain/site'
import { CapabilityStatusBadge, Container } from './layout-primitives'

const EMPLOYEE_ICONS: Record<EmployeeIcon, LucideIcon> = {
  support: Headset,
  sales: Briefcase,
  assistant: CalendarClock,
  marketing: Megaphone,
  operations: Settings2,
  analytics: BarChart3,
  voice: Phone,
  custom: Sparkles,
}

export function EmployeeIconBadge({ icon, className }: { icon: EmployeeIcon; className?: string }) {
  const Icon = EMPLOYEE_ICONS[icon]
  return (
    <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary', className)}>
      <Icon aria-hidden="true" className="size-5" />
    </span>
  )
}

/** Compact category card for overviews (home page). */
export function EmployeeCategoryCard({ category, headingLevel = 3 }: { category: EmployeeCategory; headingLevel?: 3 | 4 }) {
  const Heading = `h${headingLevel}` as const
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <EmployeeIconBadge icon={category.icon} />
        <CapabilityStatusBadge status={category.status} />
      </div>
      <Heading className="font-semibold">{category.name}</Heading>
      <p className="text-sm text-pretty text-muted-foreground">{category.summary}</p>
    </li>
  )
}

/** Capabilities of one or more areas, each with its status. */
export function CapabilityList({ areas, headingLevel = 3 }: { areas: readonly CapabilityArea[]; headingLevel?: 3 | 4 }) {
  const Heading = `h${headingLevel}` as const
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {areas.map((area) => (
        <div key={area} className="flex flex-col gap-4 rounded-xl border bg-card p-5">
          <div className="flex flex-col gap-1">
            <Heading className="font-semibold">{CAPABILITY_AREAS[area].title}</Heading>
            <p className="text-sm text-pretty text-muted-foreground">{CAPABILITY_AREAS[area].summary}</p>
          </div>
          <ul className="flex flex-col divide-y">
            {[...CAPABILITIES[area]]
              .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
              .map((capability) => (
                <li key={capability.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{capability.title}</span>
                    <CapabilityStatusBadge status={capability.status} />
                  </div>
                  <p className="text-sm text-pretty text-muted-foreground">{capability.description}</p>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** Closing call to action at the bottom of a page. */
export function CtaBand({
  title = 'Want to try Nexefiy when it opens?',
  description = 'Tell us about your business and what you’d like AI employees to help with. We’ll get in touch when early access starts.',
}: {
  title?: string
  description?: string
}) {
  return (
    <section aria-labelledby="cta-heading" className="py-14 sm:py-20">
      <Container>
        <div className="flex flex-col gap-6 rounded-2xl bg-primary px-6 py-10 text-primary-foreground sm:px-10 md:flex-row md:items-center md:justify-between">
          <div className="flex max-w-2xl flex-col gap-2">
            <h2 id="cta-heading" className="text-2xl font-semibold tracking-tight text-balance">
              {title}
            </h2>
            <p className="text-pretty opacity-90">{description}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <Button asChild size="lg" variant="secondary" className="h-10 px-4">
              <Link href={EARLY_ACCESS_HREF}>Get early access</Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-10 border-primary-foreground/40 bg-transparent px-4 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
            >
              <Link href={PUBLIC_PAGES.gettingStarted.path}>How to get started</Link>
            </Button>
          </div>
        </div>
      </Container>
    </section>
  )
}

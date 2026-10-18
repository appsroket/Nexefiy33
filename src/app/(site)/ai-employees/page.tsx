import { Ban, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import {
  EMPLOYEE_BUILDING_BLOCKS,
  EMPLOYEE_CATEGORIES,
  OTHER_PLANNED_ROLES,
} from '@/modules/marketing/domain/employees'
import { EARLY_ACCESS_HREF, PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { CtaBand, EmployeeIconBadge } from '@/modules/marketing/ui/content-blocks'
import {
  CapabilityStatusBadge,
  IllustrativeNote,
  PageIntro,
  Section,
  StatusLegend,
} from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('employees')

const LIMITS = [
  'Use a tool or app you haven’t granted it',
  'See another business’s data, or choose which workspace it works in',
  'Skip an approval your rules require, or change its own permissions',
  'Act after you pause it: work stops before the next step',
] as const

export default function AiEmployeesPage() {
  return (
    <>
      <PageIntro
        eyebrow="AI employees"
        title="Hire for the role, then decide what it may do"
        lead="An AI employee in Nexefiy is a role you configure: what it’s for, what it knows about your business, which tools it may use, and which actions need your approval. None of the roles below is available yet."
        actions={
          <>
            <Button asChild size="lg" className="h-10 px-4">
              <Link href={EARLY_ACCESS_HREF}>Get early access</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-10 px-4">
              <Link href={PUBLIC_PAGES.useCases.path}>See example use cases</Link>
            </Button>
          </>
        }
      />

      <Section
        id="building-blocks"
        title="Every AI employee is built from the same four parts"
        description="A sales employee and a support employee differ only in how these parts are set up, so every role follows the same rules."
      >
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {EMPLOYEE_BUILDING_BLOCKS.map((block, index) => (
            <li key={block.title} className="flex flex-col gap-2 rounded-xl border bg-card p-5">
              <span className="text-sm font-medium text-primary">Part {index + 1}</span>
              <h3 className="font-semibold">{block.title}</h3>
              <p className="text-sm text-pretty text-muted-foreground">{block.description}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        id="roles"
        tone="muted"
        title="Roles"
        description="Three roles and a blank employee are planned for the first release; the others come later."
      >
        <StatusLegend />
        <IllustrativeNote>
          the example tasks show what each role is designed to do. They aren’t results from customers.
        </IllustrativeNote>
        <ul className="grid gap-4 lg:grid-cols-2">
          {EMPLOYEE_CATEGORIES.map((category) => (
            <li key={category.id} id={category.id} className="flex scroll-mt-24 flex-col gap-4 rounded-xl border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <EmployeeIconBadge icon={category.icon} />
                  <h3 className="text-lg font-semibold">{category.name}</h3>
                </div>
                <CapabilityStatusBadge status={category.status} />
              </div>
              <p className="text-pretty text-muted-foreground">{category.summary}</p>
              <div className="flex flex-col gap-1.5">
                <h4 className="text-sm font-medium">Example tasks</h4>
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {category.exampleTasks.map((task) => (
                    <li key={task} className="flex gap-2">
                      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                      {task}
                    </li>
                  ))}
                </ul>
              </div>
              <dl className="grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
                <div className="flex flex-col gap-0.5">
                  <dt className="font-medium">Works in</dt>
                  <dd className="text-muted-foreground">{category.tools.join(', ')}</dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="font-medium">Needs approval by default</dt>
                  <dd className="text-muted-foreground">{category.approvals}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Also planned for later: {OTHER_PLANNED_ROLES.join(', ')} roles.
        </p>
      </Section>

      <Section
        id="limits"
        title="What an AI employee can’t do"
        description="These limits are part of the design and are enforced by Nexefiy’s servers, not left to the AI. They arrive with the first release, along with the AI employees themselves."
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          {LIMITS.map((limit) => (
            <li key={limit} className="flex gap-3 rounded-xl border bg-card p-4 text-sm">
              <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
              {limit}
            </li>
          ))}
        </ul>
      </Section>

      <CtaBand />
    </>
  )
}

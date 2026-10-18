import { ArrowRight, Eye, ListChecks, Lock, ShieldCheck } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { CAPABILITY_AREAS, type CapabilityArea } from '@/modules/marketing/domain/capabilities'
import { EMPLOYEE_CATEGORIES, HIGHLIGHTED_CATEGORY_IDS } from '@/modules/marketing/domain/employees'
import { EARLY_ACCESS_HREF, PRODUCT_STATUS, PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { CapabilityList, CtaBand, EmployeeCategoryCard } from '@/modules/marketing/ui/content-blocks'
import { Container, Section, StatusLegend } from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'
import { ProductPreview } from '@/modules/marketing/ui/product-preview'

export const metadata = pageMetadata('home', { absoluteTitle: 'Nexefiy: supervised AI employees for your business' })

const STEPS: readonly { area: CapabilityArea; href: string; linkLabel: string }[] = [
  { area: 'configure', href: PUBLIC_PAGES.employees.path, linkLabel: 'About AI employees' },
  { area: 'connect', href: PUBLIC_PAGES.integrations.path, linkLabel: 'Planned integrations' },
  { area: 'coordinate', href: PUBLIC_PAGES.useCases.path, linkLabel: 'Example workflows' },
  { area: 'supervise', href: PUBLIC_PAGES.security.path, linkLabel: 'How control works' },
]

const PRINCIPLES = [
  {
    icon: ListChecks,
    title: 'AI proposes, your rules decide',
    description:
      'Every action an AI employee wants to take is checked against the permissions and approval rules you set, on our servers, not by the AI itself.',
  },
  {
    icon: Eye,
    title: 'Nothing happens out of sight',
    description: 'Each step an AI employee takes is recorded, so you can see what it did, why, and who approved it.',
  },
  {
    icon: Lock,
    title: 'Your data stays yours',
    description: 'Each business’s workspace is separated from every other at the database level.',
  },
  {
    icon: ShieldCheck,
    title: 'Honest status',
    description: 'An app connection is offered only after it’s tested against a real account. Until then it says “planned”.',
  },
] as const

export default function HomePage() {
  const highlighted = HIGHLIGHTED_CATEGORY_IDS.map((id) => EMPLOYEE_CATEGORIES.find((category) => category.id === id)!)

  return (
    <>
      <div className="border-b bg-gradient-to-b from-primary/5 to-transparent">
        <Container className="grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[1fr_1.1fr]">
          <div className="flex flex-col gap-6">
            <p className="w-fit rounded-full border bg-background px-3 py-1 text-sm text-muted-foreground">
              In early development · AI employees not available yet
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              AI employees your business can supervise
            </h1>
            <p className="text-lg text-pretty text-muted-foreground">
              Nexefiy is being built so businesses can configure AI employees, connect the tools they already use,
              coordinate work through workflows, and approve what matters before it happens.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className="h-10 px-4">
                <Link href={EARLY_ACCESS_HREF}>Get early access</Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-10 px-4">
                <Link href="#whats-built">See what’s built</Link>
              </Button>
            </div>
          </div>
          <ProductPreview />
        </Container>
      </div>

      <Section
        id="how-it-works"
        title="How Nexefiy is designed to work"
        description="Four things, in one place. Most of this is planned; the status of each part is listed further down."
      >
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.area} className="flex flex-col gap-3 rounded-xl border bg-card p-5">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {index + 1}
              </span>
              <h3 className="font-semibold">{CAPABILITY_AREAS[step.area].title}</h3>
              <p className="flex-1 text-sm text-pretty text-muted-foreground">{CAPABILITY_AREAS[step.area].summary}</p>
              <Link
                href={step.href}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {step.linkLabel}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        id="employees"
        tone="muted"
        title="AI employees for different parts of your business"
        description="Every role runs on the same foundation: instructions, knowledge, tools and approval rules. These are the categories we’re designing for."
      >
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {highlighted.map((category) => (
            <EmployeeCategoryCard key={category.id} category={category} />
          ))}
        </ul>
        <div>
          <Button asChild variant="outline" size="lg">
            <Link href={PUBLIC_PAGES.employees.path}>
              All AI employee roles
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      </Section>

      <Section
        id="principles"
        title="Supervised by default"
        description="The rules we’re building Nexefiy around. They describe the design; the list below says which parts exist today."
      >
        <ul className="grid gap-6 sm:grid-cols-2">
          {PRINCIPLES.map(({ icon: Icon, title, description }) => (
            <li key={title} className="flex gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon aria-hidden="true" className="size-5" />
              </span>
              <div className="flex flex-col gap-1">
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-pretty text-muted-foreground">{description}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="whats-built" tone="muted" title="What’s built and what’s planned" description={PRODUCT_STATUS}>
        <StatusLegend />
        <CapabilityList areas={['platform', 'configure', 'connect', 'coordinate', 'supervise']} />
      </Section>

      <CtaBand />
    </>
  )
}

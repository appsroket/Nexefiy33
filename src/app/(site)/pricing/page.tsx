import { ChevronDown } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import type { CapabilityStatus } from '@/modules/marketing/domain/capabilities'
import { EARLY_ACCESS_HREF } from '@/modules/marketing/domain/site'
import { CtaBand } from '@/modules/marketing/ui/content-blocks'
import { CapabilityStatusBadge, PageIntro, Section } from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('pricing')

// Structure from docs/billing-and-entitlements.md §2. Prices and limits are
// owner decisions that haven't been made: never show numbers here until they are.
const PLANS: readonly { name: string; summary: string; status: CapabilityStatus }[] = [
  {
    name: 'Free trial',
    summary: 'Try Nexefiy with a small number of AI employees and workflows before paying.',
    status: 'first_release',
  },
  {
    name: 'Two paid plans',
    summary: 'For small teams and for growing businesses, with higher limits on the larger plan.',
    status: 'first_release',
  },
  {
    name: 'Enterprise',
    summary: 'Custom limits, single sign-on and contract terms for larger organizations.',
    status: 'later',
  },
]

const LIMITS = [
  'Number of AI employees',
  'Number of active workflows',
  'Tasks completed per month',
  'Connected apps',
  'Team members',
] as const

const FAQ = [
  {
    question: 'Can I buy Nexefiy today?',
    answer: 'No. Nexefiy is in early development and there is nothing to pay for.',
  },
  {
    question: 'Will there be a free trial?',
    answer: 'A free trial is planned for the first release. Its length, its limits, and whether it needs a card haven’t been decided.',
  },
  {
    question: 'How will AI usage be charged?',
    answer:
      'That hasn’t been decided. Plans will include a number of tasks per month; whether heavier use is billed separately is still open.',
  },
  {
    question: 'How do I find out when pricing is set?',
    answer: 'Ask for early access through the contact form and we’ll tell you when pricing is published.',
  },
] as const

export default function PricingPage() {
  return (
    <>
      <PageIntro
        eyebrow="Pricing"
        title="Pricing isn’t set yet"
        lead="We haven’t decided prices or plan limits, so this page shows only the structure we’re working toward. We won’t publish numbers until they’re final."
        actions={
          <Button asChild size="lg" className="h-10 px-4">
            <Link href={EARLY_ACCESS_HREF}>Get notified about early access</Link>
          </Button>
        }
      />

      <Section id="plans" title="Planned plan structure" description="Billing will be per workspace, through Stripe.">
        <ul className="grid gap-4 md:grid-cols-3">
          {PLANS.map((plan) => (
            <li key={plan.name} className="flex flex-col gap-3 rounded-xl border bg-card p-6">
              <CapabilityStatusBadge status={plan.status} className="w-fit" />
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <p className="flex-1 text-sm text-pretty text-muted-foreground">{plan.summary}</p>
              <p className="border-t pt-3 text-sm">
                <span className="font-medium">Price: </span>
                <span className="text-muted-foreground">not decided</span>
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="limits"
        tone="muted"
        title="What plans will differ by"
        description="Limits will be enforced by Nexefiy’s servers, and you’ll always be able to see how much of each you’ve used."
      >
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {LIMITS.map((limit) => (
            <li key={limit} className="rounded-lg border bg-card px-4 py-3 text-sm">
              {limit}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="questions" title="Questions">
        <div className="flex max-w-3xl flex-col divide-y rounded-xl border bg-card">
          {FAQ.map((item) => (
            <details key={item.question} className="group p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded font-medium [&::-webkit-details-marker]:hidden">
                {item.question}
                <ChevronDown aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm text-pretty text-muted-foreground">{item.answer}</p>
            </details>
          ))}
        </div>
      </Section>

      <CtaBand />
    </>
  )
}

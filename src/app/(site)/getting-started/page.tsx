import { ArrowRight, Mail, ShieldCheck, UserPlus } from 'lucide-react'
import Link from 'next/link'

import type { CapabilityStatus } from '@/modules/marketing/domain/capabilities'
import { EARLY_ACCESS_HREF, PRODUCT_STATUS, PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { CtaBand } from '@/modules/marketing/ui/content-blocks'
import { CapabilityStatusBadge, PageIntro, Section, StatusLegend } from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('gettingStarted')

const TODAY = [
  {
    icon: Mail,
    title: 'Ask for early access',
    description: 'Tell us about your business and what you’d like help with. We’ll contact you when AI employees are ready to try.',
    href: EARLY_ACCESS_HREF,
    linkLabel: 'Go to the contact form',
  },
  {
    icon: UserPlus,
    title: 'Create your workspace',
    description:
      'Create an account, set up a workspace for your company and invite your team. Most sections of the workspace are still marked “Soon”.',
    href: PUBLIC_PAGES.signUp.path,
    linkLabel: 'Create an account',
  },
  {
    icon: ShieldCheck,
    title: 'Check how it’s secured',
    description: 'Read how data is separated, how credentials are protected, and what exists today.',
    href: PUBLIC_PAGES.security.path,
    linkLabel: 'Read about security',
  },
] as const

const SETUP_STEPS: readonly { title: string; description: string; status: CapabilityStatus }[] = [
  { title: 'Create your account and workspace', description: 'Sign up and name your workspace.', status: 'built' },
  {
    title: 'Invite your team',
    description: 'Invite people by email and give each one a role: owner, admin, operator or viewer.',
    status: 'built',
  },
  {
    title: 'Describe your business',
    description: 'Add your products, policies and tone, and upload documents your AI employees should use.',
    status: 'first_release',
  },
  {
    title: 'Connect your apps',
    description: 'Sign in to Gmail, Google Calendar, Slack or HubSpot and approve the access Nexefiy asks for.',
    status: 'first_release',
  },
  {
    title: 'Create your first AI employee',
    description: 'Start from a template, adjust its instructions, and grant it the tools it needs.',
    status: 'first_release',
  },
  {
    title: 'Set your approval rules',
    description: 'Choose which actions run automatically and which wait for you.',
    status: 'first_release',
  },
  {
    title: 'Give it work',
    description: 'Assign a task directly, or describe a process and review the workflow Nexefiy drafts.',
    status: 'first_release',
  },
  {
    title: 'Supervise and review',
    description: 'Approve or reject requests and follow each step in the activity history.',
    status: 'first_release',
  },
]

export default function GettingStartedPage() {
  return (
    <>
      <PageIntro eyebrow="Getting started" title="Getting started with Nexefiy" lead={PRODUCT_STATUS} />

      <Section id="today" title="What you can do today">
        <ul className="grid gap-4 md:grid-cols-3">
          {TODAY.map(({ icon: Icon, title, description, href, linkLabel }) => (
            <li key={title} className="flex flex-col gap-3 rounded-xl border bg-card p-5">
              <Icon aria-hidden="true" className="size-5 text-primary" />
              <h3 className="font-semibold">{title}</h3>
              <p className="flex-1 text-sm text-pretty text-muted-foreground">{description}</p>
              <Link
                href={href}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {linkLabel}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="setup"
        tone="muted"
        title="How setup works"
        description="From signing up to supervising AI employees. Steps marked “Built” work today; the rest are planned."
      >
        <StatusLegend />
        <ol className="flex max-w-3xl flex-col gap-3">
          {SETUP_STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4 rounded-xl border bg-card p-5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {index + 1}
              </span>
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{step.title}</h3>
                  <CapabilityStatusBadge status={step.status} />
                </div>
                <p className="text-sm text-pretty text-muted-foreground">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        id="prepare"
        title="Worth preparing in advance"
        description="Nothing here is required to ask for early access."
      >
        <ul className="grid max-w-3xl gap-3 text-sm sm:grid-cols-2">
          <li className="rounded-lg border bg-card p-4">
            Documents that describe your business: FAQs, policies, price lists, product information.
          </li>
          <li className="rounded-lg border bg-card p-4">
            Someone who can approve access to your Google Workspace, Slack or HubSpot accounts.
          </li>
          <li className="rounded-lg border bg-card p-4">
            One repetitive process you’d like to hand over first, and who should approve its actions.
          </li>
          <li className="rounded-lg border bg-card p-4">The people on your team who should be able to see or approve work.</li>
        </ul>
      </Section>

      <CtaBand />
    </>
  )
}

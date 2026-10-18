import { KeyRound, Plug, Wrench } from 'lucide-react'

import {
  BUILT_IN_TOOLS,
  LATER_INTEGRATION_CATEGORIES,
  PLANNED_INTEGRATIONS,
} from '@/modules/marketing/domain/integrations'
import { CtaBand } from '@/modules/marketing/ui/content-blocks'
import {
  CapabilityStatusBadge,
  PageIntro,
  Section,
  StatusLegend,
  TextLink,
} from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('integrations')

const CONNECTION_SECURITY = [
  {
    title: 'Encrypted before storage',
    description:
      'Access tokens for connected apps are encrypted before they are saved, and encryption keys can be rotated.',
    status: 'built',
  },
  {
    title: 'You approve the access',
    description: 'You connect each app by signing in to it yourself and reviewing the permissions it asks for.',
    status: 'first_release',
  },
  {
    title: 'Granted tool by tool',
    description:
      'Connecting an app doesn’t give every AI employee access to it. You grant specific actions to specific employees.',
    status: 'first_release',
  },
  {
    title: 'Disconnect at any time',
    description: 'Removing a connection stops every AI employee from using it immediately.',
    status: 'first_release',
  },
] as const

export default function IntegrationsPage() {
  return (
    <>
      <PageIntro
        eyebrow="Integrations"
        title="Work where your business already works"
        lead="AI employees will act in the apps you already use, with the permissions you grant. No integration is available yet: each will be offered only after it has been tested against a real account."
      />

      <Section
        id="first-release"
        title="Planned for the first release"
        description="What an AI employee could do in each app, and which events could start a workflow."
      >
        <StatusLegend />
        <ul className="grid gap-4 md:grid-cols-2">
          {PLANNED_INTEGRATIONS.map((integration) => (
            <li key={integration.id} className="flex flex-col gap-4 rounded-xl border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-muted">
                    <Plug aria-hidden="true" className="size-5 text-muted-foreground" />
                  </span>
                  <div>
                    <h3 className="font-semibold">{integration.name}</h3>
                    <p className="text-sm text-muted-foreground">{integration.category}</p>
                  </div>
                </div>
                <CapabilityStatusBadge status={integration.status} />
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-medium">Actions</dt>
                  <dd>
                    <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
                      {integration.actions.map((action) => (
                        <li key={action}>{action}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Can start a workflow when</dt>
                  <dd className="mt-1 text-muted-foreground">
                    {integration.triggers.length ? integration.triggers.join('; ') : 'Not planned for the first release'}
                  </dd>
                </div>
              </dl>
              {integration.note ? (
                <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">{integration.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="built-in-tools"
        tone="muted"
        title="Built-in tools"
        description="Tools every AI employee will be able to use without connecting an app. Planned for the first release."
      >
        <ul className="grid gap-4 sm:grid-cols-3">
          {BUILT_IN_TOOLS.map((tool) => (
            <li key={tool.name} className="flex flex-col gap-2 rounded-xl border bg-card p-5">
              <Wrench aria-hidden="true" className="size-5 text-primary" />
              <h3 className="font-semibold">{tool.name}</h3>
              <p className="text-sm text-pretty text-muted-foreground">{tool.description}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="security" title="How connections are protected">
        <ul className="grid gap-4 sm:grid-cols-2">
          {CONNECTION_SECURITY.map((item) => (
            <li key={item.title} className="flex flex-col gap-2 rounded-xl border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <KeyRound aria-hidden="true" className="size-5 text-primary" />
                <CapabilityStatusBadge status={item.status} />
              </div>
              <h3 className="font-semibold">{item.title}</h3>
              <p className="text-sm text-pretty text-muted-foreground">{item.description}</p>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          More detail on the <TextLink href="/security">Security page</TextLink>.
        </p>
      </Section>

      <Section
        id="later"
        tone="muted"
        title="Under consideration for later"
        description="Kinds of apps we expect to support after the first release. No providers have been chosen."
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {LATER_INTEGRATION_CATEGORIES.map((category) => (
            <li key={category} className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
              {category}
              <CapabilityStatusBadge status="later" />
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Which app would you need first? <TextLink href="/contact?topic=product">Let us know</TextLink>.
        </p>
      </Section>

      <CtaBand />
    </>
  )
}

import { CircleAlert, ShieldAlert } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { SECURITY_NOT_YET, SECURITY_TOPICS } from '@/modules/marketing/domain/security'
import { CtaBand } from '@/modules/marketing/ui/content-blocks'
import { CapabilityStatusBadge, PageIntro, Section, StatusLegend } from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('security')

export default function SecurityPage() {
  return (
    <>
      <PageIntro
        eyebrow="Security"
        title="Built so AI can help without taking control"
        lead="Giving software access to your email, calendar and customers is a serious decision. This page explains how Nexefiy protects your data and keeps people in charge, and says plainly which parts exist today."
      >
        <StatusLegend className="max-w-4xl" />
      </PageIntro>

      {SECURITY_TOPICS.map((topic, index) => (
        <Section
          key={topic.id}
          id={topic.id}
          title={topic.title}
          description={topic.summary}
          tone={index % 2 === 1 ? 'muted' : 'plain'}
        >
          <ul className="grid gap-4 md:grid-cols-2">
            {topic.measures.map((measure) => (
              <li key={measure.title} className="flex flex-col gap-2 rounded-xl border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="font-semibold">{measure.title}</h3>
                  <CapabilityStatusBadge status={measure.status} />
                </div>
                <p className="text-sm text-pretty text-muted-foreground">{measure.description}</p>
              </li>
            ))}
          </ul>
        </Section>
      ))}

      <Section id="not-yet" tone="muted" title="What we don’t have yet">
        <ul className="flex max-w-3xl flex-col gap-3">
          {SECURITY_NOT_YET.map((statement) => (
            <li key={statement} className="flex gap-3 text-pretty">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
              {statement}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="report"
        title="Report a security issue"
        description="If you think you’ve found a vulnerability, please tell us privately through the contact form and choose the Security topic. Don’t include passwords or other secrets in your message."
      >
        <div>
          <Button asChild size="lg" className="h-10 px-4">
            <Link href="/contact?topic=security">
              <ShieldAlert aria-hidden="true" data-icon="inline-start" />
              Report a security issue
            </Link>
          </Button>
        </div>
      </Section>

      <CtaBand />
    </>
  )
}

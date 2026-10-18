import { Info } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { SearchParams } from '@/lib/list-params'
import { parseTopicParam } from '@/modules/marketing/domain/contact'
import { getContactDeliveryConfig } from '@/modules/marketing/server/contact-config'
import { ContactForm } from '@/modules/marketing/ui/contact-form'
import { Container, PageIntro } from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('contact')

export default async function ContactPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const initialTopic = parseTopicParam((await searchParams).topic)
  const available = getContactDeliveryConfig() !== null

  return (
    <>
      <PageIntro
        eyebrow="Contact"
        title="Talk to us"
        lead="Ask about early access, tell us what you’d want AI employees to help with, or report a security concern."
      />
      <Container className="grid gap-10 py-14 sm:py-20 lg:grid-cols-[1.4fr_1fr]">
        <section aria-labelledby="contact-form-heading" className="flex flex-col gap-6">
          <h2 id="contact-form-heading" className="text-xl font-semibold tracking-tight">
            Send a message
          </h2>
          {available ? null : (
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>The contact form isn’t connected yet</AlertTitle>
              <AlertDescription>
                Messages can’t be delivered until email sending is set up for this site, so the form is turned off. It
                will work as soon as it’s connected.
              </AlertDescription>
            </Alert>
          )}
          <ContactForm available={available} initialTopic={initialTopic} />
        </section>
        <aside aria-labelledby="contact-next-heading" className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-6">
            <h2 id="contact-next-heading" className="font-semibold">
              What happens next
            </h2>
            <ul className="flex flex-col gap-2 text-sm text-pretty text-muted-foreground [&_li]:ml-4 [&_li]:list-disc">
              <li>Your message goes to the Nexefiy team by email. It isn’t added to a mailing list.</li>
              <li>We reply to the email address you give us.</li>
              <li>For early access, we’ll contact you when AI employees are ready to try.</li>
            </ul>
          </div>
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-6">
            <h2 className="font-semibold">Security reports</h2>
            <p className="text-sm text-pretty text-muted-foreground">
              Choose the Security topic. Describe the issue and how to reproduce it, but don’t send passwords, keys or
              personal data.
            </p>
          </div>
        </aside>
      </Container>
    </>
  )
}

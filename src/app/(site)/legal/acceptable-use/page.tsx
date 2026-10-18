import { LegalDocument, type LegalSection } from '@/modules/marketing/ui/legal-document'
import { TextLink } from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('acceptableUse')

// Draft starting point for counsel. Not in effect.
const SECTIONS: readonly LegalSection[] = [
  {
    id: 'purpose',
    title: 'Purpose',
    body: (
      <p>
        This policy sets out what you and your AI employees may not do with Nexefiy. It applies to everyone in your
        workspace and to every action your AI employees take.
      </p>
    ),
  },
  {
    id: 'prohibited',
    title: 'Not allowed',
    body: (
      <ul>
        <li>Anything illegal, or helping others break the law.</li>
        <li>Sending spam or unsolicited bulk messages, or messages that break marketing or consent laws.</li>
        <li>
          Deceiving people, including impersonating a person or organization, or hiding that a message came from an AI
          where the law requires disclosure.
        </li>
        <li>Harassment, threats, discrimination, or content that exploits or endangers children.</li>
        <li>Collecting or processing personal information without a lawful basis.</li>
        <li>
          Making decisions with legal or similarly significant effects on people, such as hiring, credit or housing,
          without meaningful human review.
        </li>
        <li>Breaking the terms of apps you connect.</li>
      </ul>
    ),
  },
  {
    id: 'platform',
    title: 'Protecting the platform',
    body: (
      <ul>
        <li>Don’t try to get around approval rules, usage limits or permissions.</li>
        <li>Don’t try to access another workspace’s data or anyone else’s account.</li>
        <li>
          Don’t probe or test Nexefiy’s security without written permission. To report a problem, use the{' '}
          <TextLink href="/contact?topic=security">contact form</TextLink>.
        </li>
        <li>Don’t upload malware or overload the service.</li>
        <li>Don’t resell access to Nexefiy without our agreement.</li>
      </ul>
    ),
  },
  {
    id: 'enforcement',
    title: 'Enforcement',
    body: (
      <p>
        We may pause AI employees, remove content, or suspend access to stop a breach of this policy. [Describe notice
        and appeal process.]
      </p>
    ),
  },
  {
    id: 'report',
    title: 'Reporting misuse',
    body: (
      <p>
        Report misuse through the <TextLink href="/contact">contact form</TextLink> or at [abuse contact email].
      </p>
    ),
  },
]

export default function AcceptableUsePage() {
  return (
    <LegalDocument
      title="Acceptable Use Policy"
      summary="What Nexefiy may and may not be used for."
      sections={SECTIONS}
    />
  )
}

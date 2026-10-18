import { LegalDocument, type LegalSection } from '@/modules/marketing/ui/legal-document'
import { TextLink } from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('terms')

// Draft starting point for counsel. Not in effect.
const SECTIONS: readonly LegalSection[] = [
  {
    id: 'agreement',
    title: 'Agreement',
    body: (
      <p>
        These terms are an agreement between [Company legal name] (“we”) and the business or person using Nexefiy
        (“you”). By creating an account or using the service, you agree to them. If you use Nexefiy for a business,
        you confirm you can bind that business.
      </p>
    ),
  },
  {
    id: 'service',
    title: 'The service',
    body: (
      <p>
        Nexefiy lets you configure AI employees, connect business apps, coordinate work through workflows and
        supervise what AI employees do. Nexefiy is in development: features described on our website as planned may
        change or may not be offered.
      </p>
    ),
  },
  {
    id: 'accounts',
    title: 'Accounts and workspaces',
    body: (
      <ul>
        <li>You’re responsible for the people you invite to your workspace and the roles you give them.</li>
        <li>Keep sign-in details secure and tell us promptly about any unauthorized use.</li>
        <li>You must give accurate information when creating an account.</li>
      </ul>
    ),
  },
  {
    id: 'ai',
    title: 'AI employees and your decisions',
    body: (
      <>
        <p>
          AI employees produce output using AI models. That output can be inaccurate, incomplete or inappropriate.
        </p>
        <ul>
          <li>You decide which tools each AI employee may use and which actions need approval.</li>
          <li>You’re responsible for reviewing what you approve and for actions taken under the rules you set.</li>
          <li>Don’t rely on AI output for decisions with legal or similarly significant effects without human review.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'connected-apps',
    title: 'Connected apps',
    body: (
      <p>
        When you connect an app, you authorize Nexefiy to access it within the permissions you approve. Your use of
        each app remains subject to that app’s own terms. We aren’t responsible for third-party apps.
      </p>
    ),
  },
  {
    id: 'your-data',
    title: 'Your content and data',
    body: (
      <p>
        You keep ownership of the content and data you put into Nexefiy or that it accesses on your behalf. You give
        us the rights we need to host, process and transmit it to provide the service. Personal information is handled
        as described in the <TextLink href="/legal/privacy">Privacy Policy</TextLink>. [Add data processing agreement
        reference.]
      </p>
    ),
  },
  {
    id: 'acceptable-use',
    title: 'Acceptable use',
    body: (
      <p>
        You must follow the <TextLink href="/legal/acceptable-use">Acceptable Use Policy</TextLink>.
      </p>
    ),
  },
  {
    id: 'fees',
    title: 'Plans, trials and fees',
    body: (
      <p>
        Fees, limits and trial terms will be shown when you choose a plan. [Complete billing, renewal, refund and tax
        terms once pricing is decided.]
      </p>
    ),
  },
  {
    id: 'early-access',
    title: 'Early access',
    body: (
      <p>
        Early-access and trial features are provided “as is”, may change or be withdrawn, and may have limits that
        don’t apply later.
      </p>
    ),
  },
  {
    id: 'termination',
    title: 'Suspension and termination',
    body: (
      <p>
        You can stop using Nexefiy at any time. We may suspend or end access for breach of these terms or to protect
        the service or others. [Describe data export window after termination.]
      </p>
    ),
  },
  {
    id: 'disclaimers',
    title: 'Disclaimers and liability',
    body: <p>[Warranty disclaimers, limitation of liability and indemnities to be drafted by counsel.]</p>,
  },
  {
    id: 'law',
    title: 'Governing law',
    body: <p>[Governing law and jurisdiction.]</p>,
  },
  {
    id: 'changes',
    title: 'Changes to these terms',
    body: <p>We’ll post changes on this page. [Describe notice period for material changes.]</p>,
  },
]

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Service"
      summary="The terms for using Nexefiy."
      sections={SECTIONS}
    />
  )
}

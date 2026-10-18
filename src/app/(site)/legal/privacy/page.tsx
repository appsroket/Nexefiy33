import { LegalDocument, type LegalSection } from '@/modules/marketing/ui/legal-document'
import { TextLink } from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('privacy')

// Draft. Describes what the website and codebase actually do today; anything
// about the future service is marked as planned. Must be reviewed by counsel.
const SECTIONS: readonly LegalSection[] = [
  {
    id: 'who-we-are',
    title: 'Who we are',
    body: (
      <p>
        Nexefiy is operated by [Company legal name], [registered address] (“we”, “us”). For privacy questions, contact
        [privacy contact email] or use the <TextLink href="/contact">contact form</TextLink>.
      </p>
    ),
  },
  {
    id: 'scope',
    title: 'What this policy covers',
    body: (
      <p>
        This policy covers the Nexefiy website and, once it opens, the Nexefiy service. Nexefiy is in development and
        doesn’t offer accounts yet; sections about accounts and business data describe how we plan to handle them.
      </p>
    ),
  },
  {
    id: 'collect',
    title: 'Information we collect',
    body: (
      <>
        <p>
          <strong>Contact form.</strong> Your name, email address, company (optional), the topic you choose and your
          message. The form sends this to our team by email through our email provider. It isn’t stored in our
          database.
        </p>
        <p>
          <strong>Accounts (planned).</strong> Your name, email address, the workspaces you belong to and your role in
          each.
        </p>
        <p>
          <strong>Business content (planned).</strong> Information you add for your AI employees, such as business
          details and documents, and data from apps you connect that AI employees process to do their work.
        </p>
        <p>
          <strong>Connected-app credentials (planned).</strong> Access tokens for apps you connect, stored encrypted.
        </p>
        <p>
          <strong>Technical information.</strong> Our hosting provider keeps standard server logs, which can include
          IP addresses and the pages requested. We remove keys, tokens and passwords before anything is written to our
          own logs. The contact form uses your IP address briefly, in memory, to limit repeated submissions; it isn’t
          stored.
        </p>
      </>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies',
    body: (
      <>
        <p>The website does not use advertising or analytics cookies. The workspace uses only essential cookies:</p>
        <ul>
          <li>sign-in session cookies, once sign-in is available;</li>
          <li>
            <code>nxf_workspace</code>, which remembers the workspace you last selected;
          </li>
          <li>
            <code>sidebar_state</code>, which remembers whether the navigation sidebar is open.
          </li>
        </ul>
        <p>[Confirm with counsel whether a consent notice is required in each market.]</p>
      </>
    ),
  },
  {
    id: 'use',
    title: 'How we use information',
    body: (
      <ul>
        <li>To reply to messages and provide early access.</li>
        <li>To provide, secure and support the service, including carrying out the work you assign to AI employees.</li>
        <li>To meet legal obligations.</li>
        <li>We do not sell personal information. [Confirm legal bases for processing in each market.]</li>
      </ul>
    ),
  },
  {
    id: 'providers',
    title: 'Service providers',
    body: (
      <>
        <p>
          We plan to use these providers to run Nexefiy. The final list will be confirmed before launch, along with
          each provider’s data processing terms.
        </p>
        <ul>
          <li>Vercel: website and application hosting.</li>
          <li>Supabase: database, sign-in and file storage.</li>
          <li>Resend: email delivery, including the contact form.</li>
          <li>Anthropic: the AI model that powers AI employees. Content an AI employee works on is sent to it.</li>
          <li>Voyage AI: search over your business documents.</li>
          <li>Stripe: payments.</li>
          <li>Trigger.dev: running long tasks in the background.</li>
          <li>Sentry: error monitoring.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'transfers',
    title: 'International transfers',
    body: <p>[Describe where data is processed and the safeguards used. The hosting region hasn’t been decided.]</p>,
  },
  {
    id: 'retention',
    title: 'How long we keep information',
    body: (
      <p>
        Contact messages: [period] in our team inbox. Account and business data: while your account is active and for
        [period] afterwards. [Complete for each category.]
      </p>
    ),
  },
  {
    id: 'rights',
    title: 'Your rights',
    body: (
      <p>
        Depending on where you live, you may have the right to access, correct, delete or export your personal
        information, and to object to or restrict how it’s used. To make a request, contact [privacy contact email].
        [Complete for each applicable law.]
      </p>
    ),
  },
  {
    id: 'security',
    title: 'Security',
    body: (
      <p>
        How we protect information, and what isn’t in place yet, is described on our{' '}
        <TextLink href="/security">Security page</TextLink>.
      </p>
    ),
  },
  {
    id: 'children',
    title: 'Children',
    body: <p>Nexefiy is a business service and isn’t intended for anyone under [age].</p>,
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: <p>We’ll post any changes on this page and update the effective date. [Describe notice for material changes.]</p>,
  },
]

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      summary="How Nexefiy collects, uses and protects personal information."
      sections={SECTIONS}
    />
  )
}

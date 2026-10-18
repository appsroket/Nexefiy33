import { AuthCard } from '@/modules/identity/ui/auth-card'
import { InvitationAcceptance } from '@/modules/identity/ui/invitation-acceptance'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = {
  ...pageMetadata('invite'),
  // The invitation token lives in the URL fragment; never leak this page's URL to other sites.
  referrer: 'no-referrer' as const,
}

export default function InvitePage() {
  return (
    <AuthCard title="Join a workspace" description="You’ve been invited to a workspace on Nexefiy.">
      <InvitationAcceptance />
    </AuthCard>
  )
}

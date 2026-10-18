import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { ChangePasswordForm, ProfileForm, SignOutEverywhereForm } from '@/modules/identity/ui/account-forms'

export const metadata: Metadata = { title: 'Your account' }

export default async function AccountPage() {
  const context = await getShellContext()
  if (context.status === 'signed_out') redirect('/sign-in?next=/app/account')
  const { user } = context

  return (
    <>
      <PageHeader title="Your account" description="Your profile, password and sign-in sessions." />
      <SectionCard title="Profile" description="Your name is shown to people in your workspaces.">
        <ProfileForm fullName={user.fullName ?? ''} email={user.email} />
      </SectionCard>
      <SectionCard title="Password">
        <ChangePasswordForm />
      </SectionCard>
      <SectionCard
        title="Sessions"
        description="Signed in on a device you no longer use, or think someone else has access? Sign out everywhere. Other devices can’t make changes from that moment, and lose access completely when their current sign-in token expires (within an hour by default)."
      >
        <SignOutEverywhereForm />
      </SectionCard>
    </>
  )
}

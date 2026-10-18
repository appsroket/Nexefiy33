import { redirect } from 'next/navigation'

import { createUserClient } from '@/lib/supabase/server'
import { AuthCard } from '@/modules/identity/ui/auth-card'
import { ResetPasswordForm } from '@/modules/identity/ui/auth-forms'
import { PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('resetPassword')

export default async function ResetPasswordPage() {
  // Reached through a password-reset link, which signs the person in first.
  const { data } = await (await createUserClient()).auth.getClaims()
  if (!data?.claims.sub) redirect(`${PUBLIC_PAGES.forgotPassword.path}?expired=1`)

  return (
    <AuthCard title="Choose a new password" description="After saving, you’ll be signed out on your other devices.">
      <ResetPasswordForm />
    </AuthCard>
  )
}

import { Alert, AlertDescription } from '@/components/ui/alert'
import { firstParam } from '@/modules/identity/domain/auth'
import { AuthCard, InlineLink } from '@/modules/identity/ui/auth-card'
import { ForgotPasswordForm } from '@/modules/identity/ui/auth-forms'
import { PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('forgotPassword')

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function ForgotPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const expired = Boolean(firstParam((await searchParams).expired))

  return (
    <AuthCard
      title="Reset your password"
      description="Enter the email address you sign in with and we’ll send you a link to choose a new password."
      footer={
        <>
          Remembered it? <InlineLink href={PUBLIC_PAGES.signIn.path}>Sign in</InlineLink>
        </>
      }
    >
      {expired ? (
        <Alert>
          <AlertDescription>
            That link has expired or was already used, or it was opened in a different browser. Ask for a new one below.
          </AlertDescription>
        </Alert>
      ) : null}
      <ForgotPasswordForm />
    </AuthCard>
  )
}

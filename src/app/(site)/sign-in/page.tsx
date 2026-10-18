import { DEFAULT_AFTER_SIGN_IN, firstParam, safeNextPath, signInNotice } from '@/modules/identity/domain/auth'
import { AuthCard, InlineLink } from '@/modules/identity/ui/auth-card'
import { SignInForm } from '@/modules/identity/ui/auth-forms'
import { PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('signIn')

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const next = safeNextPath(firstParam(params.next))
  const notice = firstParam(params.signed_out) ? 'You’ve been signed out.' : signInNotice(firstParam(params.error))
  const signUpHref = next === DEFAULT_AFTER_SIGN_IN ? PUBLIC_PAGES.signUp.path : `${PUBLIC_PAGES.signUp.path}?next=${next}`

  return (
    <AuthCard
      title="Sign in"
      description="Sign in to your Nexefiy workspace."
      footer={
        <>
          New to Nexefiy? <InlineLink href={signUpHref}>Create an account</InlineLink>
        </>
      }
    >
      <SignInForm next={next} notice={notice} />
    </AuthCard>
  )
}

import { DEFAULT_AFTER_SIGN_IN, firstParam, safeNextPath } from '@/modules/identity/domain/auth'
import { AuthCard, InlineLink } from '@/modules/identity/ui/auth-card'
import { SignUpForm } from '@/modules/identity/ui/auth-forms'
import { PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('signUp')

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const next = safeNextPath(firstParam((await searchParams).next))
  const signInHref = next === DEFAULT_AFTER_SIGN_IN ? PUBLIC_PAGES.signIn.path : `${PUBLIC_PAGES.signIn.path}?next=${next}`

  return (
    <AuthCard
      title="Create an account"
      description="Nexefiy is in early development. With an account you can create a workspace and invite your team; AI employees and app connections aren’t available yet."
      footer={
        <>
          Already have an account? <InlineLink href={signInHref}>Sign in</InlineLink>
        </>
      }
    >
      <SignUpForm next={next} />
    </AuthCard>
  )
}

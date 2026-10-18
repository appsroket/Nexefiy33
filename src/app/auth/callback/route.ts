// Landing point for Supabase Auth email links (sign-up confirmation, password
// reset) using the default email templates: exchanges the one-time code for a
// session (PKCE), then continues to a known in-app path. The code is never logged.

import { NextResponse, type NextRequest } from 'next/server'

import { createUserClient } from '@/lib/supabase/server'
import { AUTH_PATHS, safeNextPath } from '@/modules/identity/domain/auth'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const next = safeNextPath(url.searchParams.get('next'))
  const code = url.searchParams.get('code')

  if (code) {
    const supabase = await createUserClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, url))
    console.error('[identity] email link sign-in failed', { code: error.code ?? 'unknown', status: error.status ?? 0 })
  }

  // Missing, used or expired code, or a link opened in another browser (the
  // PKCE verifier lives in a cookie of the browser that asked for the email).
  const fallback =
    next === AUTH_PATHS.resetPassword
      ? new URL(`${AUTH_PATHS.forgotPassword}?expired=1`, url)
      : new URL(`${AUTH_PATHS.signIn}?error=link`, url)
  return NextResponse.redirect(fallback)
}

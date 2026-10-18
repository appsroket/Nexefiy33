// Landing point for Supabase Auth email links built from customized email
// templates ({{ .TokenHash }}): verifies the one-time token hash. Unlike the
// code exchange in /auth/callback, this works when the link is opened in a
// different browser. See docs/credential-setup.md (Supabase Auth emails).

import type { EmailOtpType } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

import { createUserClient } from '@/lib/supabase/server'
import { AUTH_PATHS, safeNextPath } from '@/modules/identity/domain/auth'

const OTP_TYPES: readonly EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email']

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value)
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type')
  const next = type === 'recovery' ? AUTH_PATHS.resetPassword : safeNextPath(url.searchParams.get('next'))

  if (tokenHash && isOtpType(type)) {
    const supabase = await createUserClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) return NextResponse.redirect(new URL(next, url))
    console.error('[identity] email link verification failed', { code: error.code ?? 'unknown', status: error.status ?? 0 })
  }

  const fallback =
    type === 'recovery'
      ? new URL(`${AUTH_PATHS.forgotPassword}?expired=1`, url)
      : new URL(`${AUTH_PATHS.signIn}?error=link`, url)
  return NextResponse.redirect(fallback)
}

// Browser-safe configuration. Only NEXT_PUBLIC_* values, which are public by
// design. Each variable is referenced literally (process.env.NEXT_PUBLIC_X)
// because Next.js inlines only literal references into client bundles.

import { httpUrl, startsWithAny, supabaseLegacyJwt } from './validators'

export interface PublicEnv {
  supabaseUrl: string
  supabasePublishableKey: string
  appUrl: string
  stripePublishableKey?: string
}

export interface RawPublicEnv {
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string
  NEXT_PUBLIC_APP_URL?: string
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?: string
}

export class PublicEnvError extends Error {
  override name = 'PublicEnvError'
}

export function parsePublicEnv(raw: RawPublicEnv, isProduction: boolean): PublicEnv {
  const problems: string[] = []
  const supabaseUrl = raw.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? ''
  const supabasePublishableKey = raw.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''

  if (!httpUrl(supabaseUrl)) problems.push('NEXT_PUBLIC_SUPABASE_URL is missing or not a valid URL')
  if (!startsWithAny('sb_publishable_')(supabasePublishableKey) && !supabaseLegacyJwt('anon')(supabasePublishableKey)) {
    problems.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing or not a publishable key')
  }

  let appUrl = raw.NEXT_PUBLIC_APP_URL?.trim()
  if (!appUrl) {
    if (isProduction) problems.push('NEXT_PUBLIC_APP_URL is missing')
    appUrl = 'http://localhost:3000'
  } else if (!httpUrl(appUrl)) {
    problems.push('NEXT_PUBLIC_APP_URL is not a valid URL')
  }

  // Stripe is optional: an invalid or absent key only disables billing UI.
  const stripeKey = raw.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim()
  const stripePublishableKey = stripeKey && startsWithAny('pk_test_', 'pk_live_')(stripeKey) ? stripeKey : undefined

  if (problems.length) {
    throw new PublicEnvError(
      `Public configuration is invalid: ${problems.join('; ')}. See docs/credential-setup.md and run npm run env:check.`,
    )
  }
  return { supabaseUrl, supabasePublishableKey, appUrl: appUrl.replace(/\/+$/, ''), stripePublishableKey }
}

let cached: PublicEnv | undefined

export function getPublicEnv(): PublicEnv {
  cached ??= parsePublicEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    },
    process.env.NODE_ENV === 'production',
  )
  return cached
}

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parsePublicEnv, PublicEnvError } from '@/lib/env/public'

import { CORE_VARS, fake } from '../helpers/env-fixtures'

describe('public environment module', () => {
  it('parses the browser-safe values', () => {
    const env = parsePublicEnv({ ...CORE_VARS, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: fake('pk_test_') }, false)
    expect(env.supabaseUrl).toBe(CORE_VARS.NEXT_PUBLIC_SUPABASE_URL)
    expect(env.appUrl).toBe('http://localhost:3000')
    expect(env.stripePublishableKey).toBe(fake('pk_test_'))
  })

  it('treats a missing Stripe key as billing disabled, not an error', () => {
    expect(parsePublicEnv(CORE_VARS, false).stripePublishableKey).toBeUndefined()
  })

  it('requires the app URL in production builds', () => {
    expect(() => parsePublicEnv(CORE_VARS, true)).toThrow(PublicEnvError)
  })

  it('reports a missing Supabase URL', () => {
    expect(() => parsePublicEnv({ ...CORE_VARS, NEXT_PUBLIC_SUPABASE_URL: undefined }, false)).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL is missing/,
    )
  })

  it('only references NEXT_PUBLIC_ variables and never imports server code', () => {
    const source = readFileSync(new URL('../../src/lib/env/public.ts', import.meta.url), 'utf8')
    const referenced = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1])
    expect(referenced.filter((name) => name !== 'NODE_ENV' && !name?.startsWith('NEXT_PUBLIC_'))).toEqual([])
    expect(source).not.toMatch(/from '\.\/(core|server|catalog)'/)
    expect(source).not.toMatch(/node:/)
  })
})

// Fake, well-formed configuration values for tests.
// Values are assembled at runtime from a prefix plus low-entropy filler so no
// realistic-looking credential is ever committed (keeps secret scanners quiet).

import type { OptionalFeatureKey } from '@/lib/env/catalog'
import type { RawEnv } from '@/lib/env/core'

export const fake = (prefix: string, length = 32): string => prefix + 'f'.repeat(length)

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A structurally valid but unsigned legacy Supabase JWT. */
export function legacySupabaseJwt(role: 'anon' | 'service_role'): string {
  return [base64url({ alg: 'HS256', typ: 'JWT' }), base64url({ iss: 'supabase', role }), 'notasignature'].join('.')
}

export const testKey = (fill: number): string => Buffer.alloc(32, fill).toString('base64')

export const CORE_VARS: RawEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example-ref.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fake('sb_publishable_'),
}

export const FEATURE_VARS: Record<OptionalFeatureKey, RawEnv> = {
  supabaseAdmin: { SUPABASE_SECRET_KEY: fake('sb_secret_') },
  ai: { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: fake('sk-ant-') },
  embeddings: { VOYAGE_API_KEY: fake('pa-', 40) },
  email: { RESEND_API_KEY: fake('re_'), EMAIL_FROM: 'Nexefiy <notifications@mail.example.com>' },
  billing: {
    STRIPE_SECRET_KEY: fake('sk_test_'),
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: fake('pk_test_'),
    STRIPE_WEBHOOK_SECRET: fake('whsec_'),
  },
  contactForm: { CONTACT_FORM_TO: 'inbox@example.com' },
  credentialEncryption: {
    INTEGRATION_ENCRYPTION_KEYS: `k1:${testKey(1)}`,
    INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  },
  googleIntegration: {
    GOOGLE_OAUTH_CLIENT_ID: '1234-fake.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: fake('GOCSPX-', 24),
  },
  slackIntegration: {
    SLACK_CLIENT_ID: '1234567890.0987654321',
    SLACK_CLIENT_SECRET: 'f'.repeat(32),
    SLACK_SIGNING_SECRET: 'e'.repeat(32),
  },
  hubspotIntegration: { HUBSPOT_CLIENT_ID: '0000-1111-2222', HUBSPOT_CLIENT_SECRET: 'f'.repeat(36) },
  backgroundJobs: { TRIGGER_SECRET_KEY: fake('tr_dev_'), TRIGGER_PROJECT_REF: 'proj_fakeproject' },
  errorMonitoring: { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0' },
  cronAuth: { CRON_SECRET: 'f'.repeat(40) },
}

/** Core plus every optional feature fully configured. */
export function fullEnv(overrides: RawEnv = {}): RawEnv {
  return Object.assign({}, CORE_VARS, ...Object.values(FEATURE_VARS), overrides)
}

/** All secret values in the fixtures, for asserting they never leak into output. */
export function fixtureSecretValues(): string[] {
  return [
    FEATURE_VARS.supabaseAdmin.SUPABASE_SECRET_KEY!,
    FEATURE_VARS.ai.ANTHROPIC_API_KEY!,
    FEATURE_VARS.embeddings.VOYAGE_API_KEY!,
    FEATURE_VARS.email.RESEND_API_KEY!,
    FEATURE_VARS.billing.STRIPE_SECRET_KEY!,
    FEATURE_VARS.billing.STRIPE_WEBHOOK_SECRET!,
    testKey(1),
    FEATURE_VARS.googleIntegration.GOOGLE_OAUTH_CLIENT_SECRET!,
    FEATURE_VARS.slackIntegration.SLACK_CLIENT_SECRET!,
    FEATURE_VARS.slackIntegration.SLACK_SIGNING_SECRET!,
    FEATURE_VARS.hubspotIntegration.HUBSPOT_CLIENT_SECRET!,
    FEATURE_VARS.backgroundJobs.TRIGGER_SECRET_KEY!,
    FEATURE_VARS.cronAuth.CRON_SECRET!,
  ]
}

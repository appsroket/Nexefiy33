import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FeatureUnavailableError,
  getFeatureStatus,
  isFeatureConfigured,
  requireFeature,
  resetEnvironmentCache,
} from '@/lib/env/server'

import { CORE_VARS, FEATURE_VARS, fake } from '../helpers/env-fixtures'

function stubEnv(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value ?? '')
}

describe('server environment module', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    // Start from a clean slate: blank every variable a feature could read.
    for (const vars of Object.values(FEATURE_VARS)) stubEnv(Object.fromEntries(Object.keys(vars).map((k) => [k, ''])))
    stubEnv({ SUPABASE_SERVICE_ROLE_KEY: '', OPENAI_API_KEY: '', APP_ENV: 'development', VERCEL_ENV: '' })
    stubEnv(CORE_VARS)
    resetEnvironmentCache()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvironmentCache()
  })

  it('returns configuration for a configured feature', () => {
    stubEnv(FEATURE_VARS.email)
    expect(requireFeature('email').from).toBe('Nexefiy <notifications@mail.example.com>')
    expect(isFeatureConfigured('email')).toBe(true)
  })

  it('throws FeatureUnavailableError naming the missing variable and the guide', () => {
    stubEnv({ RESEND_API_KEY: fake('re_') })
    const call = () => requireFeature('email')
    expect(call).toThrow(FeatureUnavailableError)
    expect(call).toThrow(/Transactional email \(Resend\) is unavailable: missing EMAIL_FROM/)
    expect(call).toThrow(/docs\/credential-setup\.md#c-email-resend/)
  })

  it('does not let a missing optional credential affect other features', () => {
    stubEnv({ ...FEATURE_VARS.ai, ...FEATURE_VARS.billing })
    expect(() => requireFeature('email')).toThrow(FeatureUnavailableError)
    expect(requireFeature('ai').provider).toBe('anthropic')
    expect(requireFeature('billing').mode).toBe('test')
  })

  it('explains a blocked integration', () => {
    stubEnv({ ...FEATURE_VARS.googleIntegration, ...FEATURE_VARS.supabaseAdmin })
    expect(getFeatureStatus('googleIntegration').state).toBe('blocked')
    expect(() => requireFeature('googleIntegration')).toThrow(/requires credentialEncryption to be configured first/)
  })

  it('error messages never include secret values', () => {
    const secret = fake('re_')
    stubEnv({ RESEND_API_KEY: secret })
    try {
      requireFeature('email')
    } catch (error) {
      expect((error as Error).message).not.toContain(secret)
    }
  })
})

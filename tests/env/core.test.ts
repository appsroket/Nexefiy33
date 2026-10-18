import { describe, expect, it } from 'vitest'

import { FEATURES, varsForFeature, type FeatureKey, type OptionalFeatureKey } from '@/lib/env/catalog'
import { parseEnvironment } from '@/lib/env/core'
import { EnvValidationError } from '@/lib/env/errors'

import {
  CORE_VARS,
  FEATURE_VARS,
  fake,
  fixtureSecretValues,
  fullEnv,
  legacySupabaseJwt,
  testKey,
} from '../helpers/env-fixtures'

const OPTIONAL_FEATURES = Object.keys(FEATURE_VARS) as OptionalFeatureKey[]

/** The feature itself plus every feature that (transitively) depends on it. */
function affectedBy(feature: OptionalFeatureKey): Set<FeatureKey> {
  const affected = new Set<FeatureKey>([feature])
  let grew = true
  while (grew) {
    grew = false
    for (const definition of Object.values(FEATURES)) {
      if (!affected.has(definition.key) && definition.dependsOn.some((d) => affected.has(d))) {
        affected.add(definition.key)
        grew = true
      }
    }
  }
  return affected
}

function catchError(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected function to throw')
}

describe('core configuration', () => {
  it('starts with only the core variables; every optional feature is not configured', () => {
    const { features, env } = parseEnvironment(CORE_VARS)
    expect(features.core.state).toBe('configured')
    for (const key of OPTIONAL_FEATURES) {
      expect(features[key].state, key).toBe('not_configured')
      expect(env[key], key).toBeUndefined()
    }
    expect(env.core.appUrl).toBe('http://localhost:3000')
  })

  it.each(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'])(
    'throws a setup-oriented error when %s is missing',
    (name) => {
      const error = catchError(() => parseEnvironment({ ...CORE_VARS, [name]: undefined }))
      expect(error).toBeInstanceOf(EnvValidationError)
      expect(error.message).toContain(`${name} is required`)
      expect(error.message).toContain('docs/credential-setup.md')
      expect(error.message).toContain('.env.local')
    },
  )

  it('treats empty and whitespace-only values as unset', () => {
    expect(() => parseEnvironment({ ...CORE_VARS, NEXT_PUBLIC_SUPABASE_URL: '   ' })).toThrow(EnvValidationError)
    const { features } = parseEnvironment({ ...CORE_VARS, ANTHROPIC_API_KEY: '', RESEND_API_KEY: ' ' })
    expect(features.ai.state).toBe('not_configured')
    expect(features.email.state).toBe('not_configured')
  })

  it('rejects an invalid core value without echoing it', () => {
    const value = 'not-a-url-SENTINEL'
    const error = catchError(() => parseEnvironment({ ...CORE_VARS, NEXT_PUBLIC_SUPABASE_URL: value }))
    expect(error.message).toContain('NEXT_PUBLIC_SUPABASE_URL must be an https URL')
    expect(error.message).not.toContain(value)
  })

  it('accepts a legacy anon JWT as the publishable key with a warning', () => {
    const { features } = parseEnvironment({
      ...CORE_VARS,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: legacySupabaseJwt('anon'),
    })
    expect(features.core.warnings.join(' ')).toContain('legacy anon JWT')
  })
})

describe('environment detection and app URL', () => {
  it('derives the environment from VERCEL_ENV, then NODE_ENV', () => {
    expect(parseEnvironment({ ...CORE_VARS, VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app' }).appEnv).toBe('preview')
    expect(parseEnvironment({ ...CORE_VARS, NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://a.b' }).appEnv).toBe(
      'production',
    )
    expect(parseEnvironment({ ...CORE_VARS, APP_ENV: 'preview', VERCEL_URL: 'x.vercel.app' }).appEnv).toBe('preview')
  })

  it('rejects an unknown APP_ENV', () => {
    expect(() => parseEnvironment({ ...CORE_VARS, APP_ENV: 'staging' })).toThrow(/APP_ENV must be one of/)
  })

  it('requires NEXT_PUBLIC_APP_URL in production', () => {
    expect(() => parseEnvironment({ ...CORE_VARS, APP_ENV: 'production' })).toThrow(/NEXT_PUBLIC_APP_URL is required/)
  })

  it('falls back to VERCEL_URL in preview and strips trailing slashes', () => {
    expect(parseEnvironment({ ...CORE_VARS, APP_ENV: 'preview', VERCEL_URL: 'nx-git-x.vercel.app' }).env.core.appUrl).toBe(
      'https://nx-git-x.vercel.app',
    )
    expect(parseEnvironment({ ...CORE_VARS, NEXT_PUBLIC_APP_URL: 'https://app.example.com/' }).env.core.appUrl).toBe(
      'https://app.example.com',
    )
  })

  it('refuses plain http for non-local app URLs', () => {
    expect(() => parseEnvironment({ ...CORE_VARS, NEXT_PUBLIC_APP_URL: 'http://app.example.com' })).toThrow(
      EnvValidationError,
    )
  })
})

describe('optional features are independent', () => {
  it('configures every feature when all credentials are present', () => {
    const { features } = parseEnvironment(fullEnv())
    for (const feature of Object.values(features)) {
      expect(feature.state, feature.key).toBe('configured')
    }
  })

  for (const feature of OPTIONAL_FEATURES) {
    // AI variables are all individually optional; the selected provider's key is what's required.
    const required = varsForFeature(feature).filter((v) =>
      feature === 'ai' ? v.name === 'ANTHROPIC_API_KEY' : !v.optional,
    )

    for (const variable of required) {
      it(`missing ${variable.name} disables only ${feature}${affectedBy(feature).size > 1 ? ' and its dependents' : ''}`, () => {
        const { features, env } = parseEnvironment(fullEnv({ [variable.name]: undefined }))
        const affected = affectedBy(feature)

        expect(features[feature].configured).toBe(false)
        expect(env[feature]).toBeUndefined()
        if (features[feature].state === 'misconfigured') {
          expect(features[feature].missing).toEqual([variable.name])
        }
        for (const other of Object.values(features)) {
          if (affected.has(other.key)) {
            expect(other.configured, other.key).toBe(false)
          } else {
            expect(other.state, `${other.key} should be unaffected`).toBe('configured')
          }
        }
      })
    }

    it(`removing all ${feature} credentials marks it not_configured without throwing`, () => {
      const cleared = Object.fromEntries(Object.keys(FEATURE_VARS[feature]).map((name) => [name, undefined]))
      const { features } = parseEnvironment(fullEnv(cleared))
      expect(features[feature].state).toBe('not_configured')
      expect(features.core.state).toBe('configured')
    })
  }

  it('marks integrations as blocked (not misconfigured) when encryption is missing', () => {
    const { features } = parseEnvironment(
      fullEnv({ INTEGRATION_ENCRYPTION_KEYS: undefined, INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID: undefined }),
    )
    for (const key of ['googleIntegration', 'slackIntegration', 'hubspotIntegration'] as const) {
      expect(features[key].state).toBe('blocked')
      expect(features[key].blockedBy).toEqual(['credentialEncryption'])
    }
  })

  it('an invalid optional value disables the feature instead of crashing the app', () => {
    const { features } = parseEnvironment(fullEnv({ RESEND_API_KEY: 'wrong-format' }))
    expect(features.email.state).toBe('misconfigured')
    expect(features.email.issues[0]?.message).toContain('RESEND_API_KEY must be a Resend API key')
    expect(features.billing.state).toBe('configured')
  })
})

describe('AI provider selection', () => {
  it('defaults to anthropic and only needs ANTHROPIC_API_KEY', () => {
    const { env, features } = parseEnvironment({ ...CORE_VARS, ANTHROPIC_API_KEY: fake('sk-ant-') })
    expect(features.ai.state).toBe('configured')
    expect(env.ai?.provider).toBe('anthropic')
  })

  it('does not require the key of an unselected provider', () => {
    const { features } = parseEnvironment({ ...CORE_VARS, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: fake('sk-ant-') })
    expect(features.ai.missing).toEqual([])
  })

  it('requires OPENAI_API_KEY when openai is selected', () => {
    const { features } = parseEnvironment({ ...CORE_VARS, AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: fake('sk-ant-') })
    expect(features.ai.state).toBe('misconfigured')
    expect(features.ai.missing).toEqual(['OPENAI_API_KEY'])
    expect(features.ai.warnings.join(' ')).toContain('ANTHROPIC_API_KEY is set but AI_PROVIDER is "openai"')
  })

  it('warns that the openai adapter is not implemented', () => {
    const { features } = parseEnvironment({ ...CORE_VARS, AI_PROVIDER: 'openai', OPENAI_API_KEY: fake('sk-proj-') })
    expect(features.ai.state).toBe('configured')
    expect(features.ai.warnings.join(' ')).toContain('not implemented')
  })

  it('rejects an unknown provider', () => {
    const { features } = parseEnvironment({ ...CORE_VARS, AI_PROVIDER: 'other', ANTHROPIC_API_KEY: fake('sk-ant-') })
    expect(features.ai.state).toBe('misconfigured')
  })
})

describe('Supabase privileged key', () => {
  it('accepts a legacy service_role JWT with a migration warning', () => {
    const { env, features } = parseEnvironment({ ...CORE_VARS, SUPABASE_SERVICE_ROLE_KEY: legacySupabaseJwt('service_role') })
    expect(env.supabaseAdmin?.keyType).toBe('legacy_service_role')
    expect(features.supabaseAdmin.warnings.join(' ')).toContain('legacy service_role JWT')
  })

  it('prefers SUPABASE_SECRET_KEY when both are set', () => {
    const { env, features } = parseEnvironment({
      ...CORE_VARS,
      SUPABASE_SECRET_KEY: fake('sb_secret_'),
      SUPABASE_SERVICE_ROLE_KEY: legacySupabaseJwt('service_role'),
    })
    expect(env.supabaseAdmin?.keyType).toBe('secret')
    expect(features.supabaseAdmin.warnings.join(' ')).toContain('ignored')
  })

  it('rejects an anon JWT supplied as the service role key', () => {
    const { features } = parseEnvironment({ ...CORE_VARS, SUPABASE_SERVICE_ROLE_KEY: legacySupabaseJwt('anon') })
    expect(features.supabaseAdmin.state).toBe('misconfigured')
  })
})

describe('Stripe key modes', () => {
  it('rejects live keys outside production', () => {
    const { features } = parseEnvironment(
      fullEnv({ STRIPE_SECRET_KEY: fake('sk_live_'), NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: fake('pk_live_') }),
    )
    expect(features.billing.state).toBe('misconfigured')
    expect(features.billing.issues.map((i) => i.message).join(' ')).toContain('Live Stripe keys are not allowed in development')
  })

  it('allows live keys in production', () => {
    const { env } = parseEnvironment(
      fullEnv({
        APP_ENV: 'production',
        NEXT_PUBLIC_APP_URL: 'https://app.example.com',
        STRIPE_SECRET_KEY: fake('rk_live_'),
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: fake('pk_live_'),
      }),
    )
    expect(env.billing?.mode).toBe('live')
  })

  it('rejects mixed test and live keys', () => {
    const { features } = parseEnvironment(fullEnv({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: fake('pk_live_') }))
    expect(features.billing.issues.map((i) => i.message).join(' ')).toContain('both be test-mode or both be live-mode')
  })
})

describe('credential encryption keyring', () => {
  it('reports keyring problems without key material', () => {
    const short = Buffer.alloc(16, 7).toString('base64')
    const { features } = parseEnvironment(fullEnv({ INTEGRATION_ENCRYPTION_KEYS: `k1:${short}` }))
    expect(features.credentialEncryption.state).toBe('misconfigured')
    const message = features.credentialEncryption.issues[0]?.message ?? ''
    expect(message).toContain('must decode to 32 bytes')
    expect(message).not.toContain(short)
  })

  it('requires the active key id to exist in the keyring', () => {
    const { features } = parseEnvironment(fullEnv({ INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID: 'k2' }))
    expect(features.credentialEncryption.issues[0]?.message).toContain('"k2" is not in the keyring')
  })

  it('parses multiple keys for rotation', () => {
    const { env } = parseEnvironment(
      fullEnv({ INTEGRATION_ENCRYPTION_KEYS: `k2:${testKey(2)}, k1:${testKey(1)}`, INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID: 'k2' }),
    )
    expect([...(env.credentialEncryption?.keyring.keys.keys() ?? [])]).toEqual(['k2', 'k1'])
  })
})

describe('secrets never reach the browser or the logs', () => {
  it.each([
    ['NEXT_PUBLIC_SUPABASE_SECRET_KEY', fake('sb_secret_')],
    ['NEXT_PUBLIC_ANTHROPIC_API_KEY', fake('sk-ant-')],
    ['NEXT_PUBLIC_STRIPE_KEY', fake('sk_live_')],
    ['NEXT_PUBLIC_SERVICE_KEY', legacySupabaseJwt('service_role')],
    ['NEXT_PUBLIC_DB_PASSWORD', 'hunter2hunter2'],
  ])('refuses %s', (name, value) => {
    const error = catchError(() => parseEnvironment({ ...CORE_VARS, [name]: value }))
    expect(error).toBeInstanceOf(EnvValidationError)
    expect(error.message).toContain(name)
    expect(error.message).not.toContain(value)
  })

  it('allows the publishable keys that are meant to be public', () => {
    expect(() =>
      parseEnvironment({ ...CORE_VARS, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: fake('pk_test_') }),
    ).not.toThrow()
  })

  it('hides secret values when the env object is serialized or inspected', async () => {
    const { env } = parseEnvironment(fullEnv())
    const { inspect } = await import('node:util')
    const outputs = [JSON.stringify(env), inspect(env, { depth: 10 })]
    for (const output of outputs) {
      for (const secret of fixtureSecretValues()) expect(output).not.toContain(secret)
    }
    expect(JSON.parse(outputs[0]!).features.ai).toBe('configured')
  })

  it('never includes values in feature problem messages', () => {
    const badValues: Record<string, string> = {
      SUPABASE_SECRET_KEY: 'bad-SENTINEL-1',
      ANTHROPIC_API_KEY: 'bad-SENTINEL-2',
      STRIPE_WEBHOOK_SECRET: 'bad-SENTINEL-3',
      CRON_SECRET: 'SENTINEL-4',
    }
    const { features } = parseEnvironment(fullEnv(badValues))
    const text = JSON.stringify(features)
    for (const value of Object.values(badValues)) expect(text).not.toContain(value)
  })
})

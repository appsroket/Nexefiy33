// Environment parsing and feature detection.
//
// Pure function of its input: no `process.env` access, no I/O. Used by the
// server module (server.ts), the env check script, and tests. Do not import
// this from client components — use public.ts there.
//
// Rules:
// - Core variables are required; missing or invalid core config throws.
// - A secret placed in a NEXT_PUBLIC_* variable always throws.
// - Every other feature is optional: missing or invalid credentials disable
//   only that feature (and features that depend on it), never the app.
// - Messages name variables but never contain values.

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../config/embeddings'
import { parseKeyring, type Keyring } from '../crypto/keyring'
import {
  ENV_VARS_BY_NAME,
  FEATURES,
  varsForFeature,
  type FeatureKey,
  type OptionalFeatureKey,
} from './catalog'
import { EnvValidationError, type EnvIssue } from './errors'
import { looksLikeSecretName, looksLikeSecretValue, supabaseLegacyJwt } from './validators'

export type RawEnv = Record<string, string | undefined>
export type AppEnvironment = 'development' | 'preview' | 'production'
export type AiProvider = 'anthropic' | 'openai'

/**
 * - `configured`: all credentials present and well-formed.
 * - `not_configured`: none of the feature's credentials are set (intentional opt-out).
 * - `misconfigured`: some are set, but others are missing or invalid.
 * - `blocked`: configured, but a feature it depends on is not.
 */
export type FeatureState = 'configured' | 'not_configured' | 'misconfigured' | 'blocked'

export interface FeatureStatus {
  key: FeatureKey
  label: string
  state: FeatureState
  configured: boolean
  missing: string[]
  issues: EnvIssue[]
  blockedBy: OptionalFeatureKey[]
  warnings: string[]
  unlocks: string
  guide: string
}

export interface ServerEnv {
  appEnv: AppEnvironment
  core: { supabaseUrl: string; supabasePublishableKey: string; appUrl: string }
  supabaseAdmin?: { key: string; keyType: 'secret' | 'legacy_service_role' }
  ai?: { provider: AiProvider; apiKey: string }
  embeddings?: { apiKey: string; model: string; dimensions: number }
  email?: { resendApiKey: string; from: string }
  contactForm?: { to: string }
  billing?: { secretKey: string; publishableKey: string; webhookSecret: string; mode: 'test' | 'live' }
  credentialEncryption?: { keyring: Keyring }
  googleIntegration?: { clientId: string; clientSecret: string }
  slackIntegration?: { clientId: string; clientSecret: string; signingSecret: string }
  hubspotIntegration?: { clientId: string; clientSecret: string }
  backgroundJobs?: { secretKey: string; projectRef: string }
  errorMonitoring?: { dsn: string }
  cronAuth?: { secret: string }
}

export interface EnvironmentSnapshot {
  appEnv: AppEnvironment
  env: ServerEnv
  features: Record<FeatureKey, FeatureStatus>
}

type Clean = Record<string, string>

export function parseEnvironment(raw: RawEnv): EnvironmentSnapshot {
  const env = clean(raw)
  const appEnv = resolveAppEnv(env)

  assertNoSecretsInPublicVars(env, appEnv)
  const core = parseCore(env, appEnv)

  const results = {
    supabaseAdmin: evaluateSupabaseAdmin(env),
    ai: evaluateAi(env),
    embeddings: evaluateAllOf(env, 'embeddings', (get) => ({
      value: { apiKey: get('VOYAGE_API_KEY'), model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS },
    })),
    email: evaluateAllOf(env, 'email', (get) => ({
      value: { resendApiKey: get('RESEND_API_KEY'), from: get('EMAIL_FROM') },
    })),
    contactForm: evaluateAllOf(env, 'contactForm', (get) => ({ value: { to: get('CONTACT_FORM_TO') } })),
    billing: evaluateAllOf(env, 'billing', (get) =>
      evaluateBillingMode(
        appEnv,
        get('STRIPE_SECRET_KEY'),
        get('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'),
        get('STRIPE_WEBHOOK_SECRET'),
      ),
    ),
    credentialEncryption: evaluateAllOf(env, 'credentialEncryption', (get) => {
      try {
        return {
          value: {
            keyring: parseKeyring(get('INTEGRATION_ENCRYPTION_KEYS'), get('INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID')),
          },
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'invalid keyring'
        return { issues: [{ variable: 'INTEGRATION_ENCRYPTION_KEYS', message: `INTEGRATION_ENCRYPTION_KEYS: ${reason}` }] }
      }
    }),
    googleIntegration: evaluateAllOf(env, 'googleIntegration', (get) => ({
      value: { clientId: get('GOOGLE_OAUTH_CLIENT_ID'), clientSecret: get('GOOGLE_OAUTH_CLIENT_SECRET') },
    })),
    slackIntegration: evaluateAllOf(env, 'slackIntegration', (get) => ({
      value: {
        clientId: get('SLACK_CLIENT_ID'),
        clientSecret: get('SLACK_CLIENT_SECRET'),
        signingSecret: get('SLACK_SIGNING_SECRET'),
      },
    })),
    hubspotIntegration: evaluateAllOf(env, 'hubspotIntegration', (get) => ({
      value: { clientId: get('HUBSPOT_CLIENT_ID'), clientSecret: get('HUBSPOT_CLIENT_SECRET') },
    })),
    backgroundJobs: evaluateAllOf(env, 'backgroundJobs', (get) => ({
      value: { secretKey: get('TRIGGER_SECRET_KEY'), projectRef: get('TRIGGER_PROJECT_REF') },
    })),
    errorMonitoring: evaluateAllOf(env, 'errorMonitoring', (get) => ({ value: { dsn: get('SENTRY_DSN') } })),
    cronAuth: evaluateAllOf(env, 'cronAuth', (get) => ({ value: { secret: get('CRON_SECRET') } })),
  } satisfies Record<OptionalFeatureKey, Evaluation<unknown>>

  const features = {
    core: status('core', { state: 'configured', missing: [], issues: [], warnings: core.warnings }),
  } as Record<FeatureKey, FeatureStatus>
  for (const key of Object.keys(results) as OptionalFeatureKey[]) {
    features[key] = status(key, results[key])
  }
  applyDependencies(features)

  const serverEnv: ServerEnv = { appEnv, core: core.value }
  for (const key of Object.keys(results) as OptionalFeatureKey[]) {
    if (features[key].configured) {
      ;(serverEnv as unknown as Record<string, unknown>)[key] = results[key].value
    }
  }
  hideSecretsFromSerialization(serverEnv, features)

  return { appEnv, env: serverEnv, features }
}

// ---------------------------------------------------------------------------

function clean(raw: RawEnv): Clean {
  const result: Clean = {}
  for (const [name, value] of Object.entries(raw)) {
    const trimmed = value?.trim()
    if (trimmed) result[name] = trimmed
  }
  return result
}

function resolveAppEnv(env: Clean): AppEnvironment {
  const explicit = env.APP_ENV
  if (explicit !== undefined) {
    if (explicit === 'development' || explicit === 'preview' || explicit === 'production') return explicit
    throw new EnvValidationError(
      [{ variable: 'APP_ENV', message: `APP_ENV ${ENV_VARS_BY_NAME.get('APP_ENV')?.formatHint}` }],
      'unknown',
    )
  }
  const vercel = env.VERCEL_ENV
  if (vercel === 'production' || vercel === 'preview' || vercel === 'development') return vercel
  return env.NODE_ENV === 'production' ? 'production' : 'development'
}

function assertNoSecretsInPublicVars(env: Clean, appEnv: AppEnvironment): void {
  const issues: EnvIssue[] = []
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('NEXT_PUBLIC_')) continue
    const serverTwin = ENV_VARS_BY_NAME.get(name.slice('NEXT_PUBLIC_'.length))
    if (looksLikeSecretName(name) || serverTwin?.secret) {
      issues.push({
        variable: name,
        message: `${name} looks like a secret but NEXT_PUBLIC_ variables are shipped to every browser. Remove the NEXT_PUBLIC_ prefix and rotate the credential if it was ever deployed.`,
      })
    } else if (looksLikeSecretValue(value)) {
      issues.push({
        variable: name,
        message: `${name} contains a value that looks like a secret credential. NEXT_PUBLIC_ variables are shipped to every browser; move it to a server-only variable and rotate it if it was ever deployed.`,
      })
    }
  }
  if (issues.length) throw new EnvValidationError(issues, appEnv)
}

function parseCore(env: Clean, appEnv: AppEnvironment) {
  const issues: EnvIssue[] = []
  const warnings: string[] = []

  const required = (name: string): string => {
    const definition = ENV_VARS_BY_NAME.get(name)!
    const value = env[name]
    if (value === undefined) {
      issues.push({ variable: name, message: `${name} is required. Find it in: ${definition.whereToFind}` })
      return ''
    }
    if (!definition.validate(value)) issues.push({ variable: name, message: `${name} ${definition.formatHint}` })
    return value
  }

  const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL')
  const supabasePublishableKey = required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  if (supabaseLegacyJwt('anon')(supabasePublishableKey)) {
    warnings.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a legacy anon JWT; switch to an "sb_publishable_" key.')
  }

  let appUrl = env.NEXT_PUBLIC_APP_URL
  const appUrlDefinition = ENV_VARS_BY_NAME.get('NEXT_PUBLIC_APP_URL')!
  if (appUrl !== undefined) {
    if (!appUrlDefinition.validate(appUrl)) {
      issues.push({ variable: 'NEXT_PUBLIC_APP_URL', message: `NEXT_PUBLIC_APP_URL ${appUrlDefinition.formatHint}` })
    }
  } else if (appEnv === 'development') {
    appUrl = 'http://localhost:3000'
  } else if (appEnv === 'preview' && env.VERCEL_URL) {
    appUrl = `https://${env.VERCEL_URL}`
  } else {
    issues.push({
      variable: 'NEXT_PUBLIC_APP_URL',
      message: `NEXT_PUBLIC_APP_URL is required in ${appEnv} (used for OAuth redirects and email links).`,
    })
  }

  if (issues.length) throw new EnvValidationError(issues, appEnv)
  return { value: { supabaseUrl, supabasePublishableKey, appUrl: (appUrl ?? '').replace(/\/+$/, '') }, warnings }
}

// --- Feature evaluation ----------------------------------------------------

interface Evaluation<T> {
  state: Exclude<FeatureState, 'blocked'>
  missing: string[]
  issues: EnvIssue[]
  warnings: string[]
  value?: T
}

interface Extra<T> {
  value?: T
  issues?: EnvIssue[]
  warnings?: string[]
}

function invalid(name: string): EnvIssue {
  return { variable: name, message: `${name} ${ENV_VARS_BY_NAME.get(name)?.formatHint ?? 'is invalid'}` }
}

/**
 * All non-optional variables of the feature must be set and valid. `build` is
 * called only then, with a getter for those (now guaranteed) values.
 */
function evaluateAllOf<T>(
  env: Clean,
  feature: OptionalFeatureKey,
  build: (get: (name: string) => string) => Extra<T>,
): Evaluation<T> {
  const names = varsForFeature(feature)
    .filter((v) => !v.optional)
    .map((v) => v.name)
  const present = names.filter((name) => env[name] !== undefined)
  if (present.length === 0) return { state: 'not_configured', missing: names, issues: [], warnings: [] }

  const missing = names.filter((name) => env[name] === undefined)
  const issues = present.filter((name) => !ENV_VARS_BY_NAME.get(name)!.validate(env[name]!)).map(invalid)
  if (missing.length || issues.length) return { state: 'misconfigured', missing, issues, warnings: [] }

  const extra = build((name) => {
    const value = env[name]
    if (value === undefined || !names.includes(name)) throw new Error(`${name} is not a required ${feature} variable`)
    return value
  })
  if (extra.issues?.length) {
    return { state: 'misconfigured', missing: [], issues: extra.issues, warnings: extra.warnings ?? [] }
  }
  return { state: 'configured', missing: [], issues: [], warnings: extra.warnings ?? [], value: extra.value }
}

function evaluateSupabaseAdmin(env: Clean): Evaluation<ServerEnv['supabaseAdmin']> {
  const secret = env.SUPABASE_SECRET_KEY
  const legacy = env.SUPABASE_SERVICE_ROLE_KEY
  const warnings: string[] = []

  if (secret !== undefined) {
    if (!ENV_VARS_BY_NAME.get('SUPABASE_SECRET_KEY')!.validate(secret)) {
      return { state: 'misconfigured', missing: [], issues: [invalid('SUPABASE_SECRET_KEY')], warnings }
    }
    if (legacy !== undefined) {
      warnings.push('SUPABASE_SERVICE_ROLE_KEY is ignored because SUPABASE_SECRET_KEY is set; remove it.')
    }
    return { state: 'configured', missing: [], issues: [], warnings, value: { key: secret, keyType: 'secret' } }
  }
  if (legacy !== undefined) {
    if (!ENV_VARS_BY_NAME.get('SUPABASE_SERVICE_ROLE_KEY')!.validate(legacy)) {
      return { state: 'misconfigured', missing: [], issues: [invalid('SUPABASE_SERVICE_ROLE_KEY')], warnings }
    }
    warnings.push('Using a legacy service_role JWT. Create an "sb_secret_" key and set SUPABASE_SECRET_KEY instead.')
    return {
      state: 'configured',
      missing: [],
      issues: [],
      warnings,
      value: { key: legacy, keyType: 'legacy_service_role' },
    }
  }
  return { state: 'not_configured', missing: ['SUPABASE_SECRET_KEY'], issues: [], warnings }
}

function evaluateAi(env: Clean): Evaluation<ServerEnv['ai']> {
  const warnings: string[] = []
  const explicitProvider = env.AI_PROVIDER
  if (explicitProvider !== undefined && !ENV_VARS_BY_NAME.get('AI_PROVIDER')!.validate(explicitProvider)) {
    return { state: 'misconfigured', missing: [], issues: [invalid('AI_PROVIDER')], warnings }
  }
  const provider = (explicitProvider ?? 'anthropic') as AiProvider
  const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
  const otherKeyName = provider === 'anthropic' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
  if (env[otherKeyName] !== undefined) {
    warnings.push(`${otherKeyName} is set but AI_PROVIDER is "${provider}"; it is not used.`)
  }

  const apiKey = env[keyName]
  if (apiKey === undefined) {
    // Choosing a provider without its key is a partial configuration.
    const state = explicitProvider === undefined ? 'not_configured' : 'misconfigured'
    return { state, missing: [keyName], issues: [], warnings }
  }
  if (!ENV_VARS_BY_NAME.get(keyName)!.validate(apiKey)) {
    return { state: 'misconfigured', missing: [], issues: [invalid(keyName)], warnings }
  }
  if (provider === 'openai') {
    warnings.push('The OpenAI adapter is not implemented yet; only the Anthropic adapter is planned for the first release.')
  }
  return { state: 'configured', missing: [], issues: [], warnings, value: { provider, apiKey } }
}

function evaluateBillingMode(
  appEnv: AppEnvironment,
  secretKey: string,
  publishableKey: string,
  webhookSecret: string,
): Extra<ServerEnv['billing']> {
  const secretMode = /^(sk|rk)_live_/.test(secretKey) ? 'live' : 'test'
  const publishableMode = publishableKey.startsWith('pk_live_') ? 'live' : 'test'
  const issues: EnvIssue[] = []
  const warnings: string[] = []

  if (secretMode !== publishableMode) {
    issues.push({
      variable: 'STRIPE_SECRET_KEY',
      message: 'STRIPE_SECRET_KEY and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must both be test-mode or both be live-mode keys.',
    })
  }
  if (secretMode === 'live' && appEnv !== 'production') {
    issues.push({
      variable: 'STRIPE_SECRET_KEY',
      message: `Live Stripe keys are not allowed in ${appEnv}; use test-mode keys outside production.`,
    })
  }
  if (secretMode === 'test' && appEnv === 'production') {
    warnings.push('Production is using Stripe test-mode keys; no real payments will be collected.')
  }
  if (issues.length) return { issues }
  return { value: { secretKey, publishableKey, webhookSecret, mode: secretMode }, warnings }
}

function status(key: FeatureKey, evaluation: Omit<Evaluation<unknown>, 'value'>): FeatureStatus {
  const definition = FEATURES[key]
  return {
    key,
    label: definition.label,
    state: evaluation.state,
    configured: evaluation.state === 'configured',
    missing: evaluation.missing,
    issues: evaluation.issues,
    blockedBy: [],
    warnings: evaluation.warnings,
    unlocks: definition.unlocks,
    guide: definition.guide,
  }
}

function applyDependencies(features: Record<FeatureKey, FeatureStatus>): void {
  for (const feature of Object.values(features)) {
    if (feature.state !== 'configured') continue
    const blockedBy = FEATURES[feature.key].dependsOn.filter((dependency) => !features[dependency].configured)
    if (blockedBy.length) {
      feature.state = 'blocked'
      feature.configured = false
      feature.blockedBy = blockedBy
    }
  }
}

/** Keeps secrets out of accidental `console.log(env)` / `JSON.stringify(env)`. */
function hideSecretsFromSerialization(env: ServerEnv, features: Record<FeatureKey, FeatureStatus>): void {
  const summary = () => ({
    appEnv: env.appEnv,
    appUrl: env.core.appUrl,
    features: Object.fromEntries(Object.values(features).map((f) => [f.key, f.state])),
    note: 'secret values hidden',
  })
  Object.defineProperty(env, 'toJSON', { value: summary, enumerable: false })
  Object.defineProperty(env, Symbol.for('nodejs.util.inspect.custom'), { value: summary, enumerable: false })
}

// Reports which Nexefiy features are configured, without printing secrets.
//
//   npm run env:check                     format/completeness only, no network
//   npm run env:check:connectivity        + safe, read-only provider checks
//   npm run env:check -- --strict         exit 1 if any feature is misconfigured
//   npm run env:check -- --connectivity --send-test-email
//                                         + send one email to Resend's test inbox
//
// Values are read from the process environment, then .env.local, then .env
// (earlier sources win, like Next.js).

import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import Anthropic from '@anthropic-ai/sdk'

import { absoluteUrl, PROVIDER_ENDPOINTS } from '../src/lib/config/endpoints'
import { ENV_VARS, FEATURES, varsForFeature, type FeatureKey } from '../src/lib/env/catalog'
import { parseEnvironment, type EnvironmentSnapshot, type FeatureStatus, type ServerEnv } from '../src/lib/env/core'
import { EnvValidationError } from '../src/lib/env/errors'

const args = new Set(process.argv.slice(2))
const strict = args.has('--strict')
const connectivity = args.has('--connectivity')
const sendTestEmail = args.has('--send-test-email')
const TIMEOUT_MS = 10_000

const ICON: Record<FeatureStatus['state'], string> = {
  configured: '✔',
  not_configured: '○',
  misconfigured: '✖',
  blocked: '!',
}

function loadEnv(): { env: Record<string, string | undefined>; sources: string[] } {
  const env: Record<string, string | undefined> = { ...process.env }
  const sources: string[] = []
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue
    sources.push(file)
    for (const [name, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (env[name] === undefined || env[name] === '') env[name] = value
    }
  }
  return { env, sources }
}

function describeValue(name: string, raw: Record<string, string | undefined>): string {
  const value = raw[name]?.trim()
  if (!value) return 'not set'
  const definition = ENV_VARS.find((v) => v.name === name)
  if (definition?.secret) return 'set (hidden)'
  if (/URL|DSN/.test(name)) return value
  return value.length > 18 ? `${value.slice(0, 14)}…` : value
}

function printFeature(feature: FeatureStatus, raw: Record<string, string | undefined>): void {
  console.log(`${ICON[feature.state]} ${feature.label} — ${feature.state.replace('_', ' ')}`)
  for (const variable of varsForFeature(feature.key)) {
    console.log(`    ${variable.name.padEnd(40)} ${describeValue(variable.name, raw)}`)
  }
  if (feature.missing.length && feature.state !== 'not_configured') {
    console.log(`    missing: ${feature.missing.join(', ')}`)
  }
  for (const issue of feature.issues) console.log(`    problem: ${issue.message}`)
  if (feature.blockedBy.length) console.log(`    blocked by: ${feature.blockedBy.join(', ')}`)
  for (const warning of feature.warnings) console.log(`    warning: ${warning}`)
  if (!feature.configured) {
    console.log(`    disabled: ${feature.unlocks}`)
    console.log(`    setup: ${feature.guide}`)
  }
}

// --- Connectivity checks ------------------------------------------------------
// Each check is read-only (except the opt-in test email), sends credentials
// only to the provider that issued them, and never prints response bodies.

type CheckResult = { ok: boolean; detail: string }

async function httpStatus(url: string, init: RequestInit): Promise<number> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  await response.body?.cancel()
  return response.status
}

const statusDetail = (status: number): CheckResult =>
  status >= 200 && status < 300
    ? { ok: true, detail: `HTTP ${status}` }
    : { ok: false, detail: `HTTP ${status}${status === 401 || status === 403 ? ' (credential rejected)' : ''}` }

const CHECKS: Partial<Record<FeatureKey, (env: ServerEnv) => Promise<CheckResult>>> = {
  core: async (env) =>
    statusDetail(
      await httpStatus(`${env.core.supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: env.core.supabasePublishableKey },
      }),
    ),

  supabaseAdmin: async (env) => {
    // Admin endpoint: succeeds only with a privileged key. Reads at most one
    // user record; the response body is discarded unread.
    const { key } = env.supabaseAdmin!
    return statusDetail(
      await httpStatus(`${env.core.supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
        headers: { apikey: key, authorization: `Bearer ${key}` },
      }),
    )
  },

  ai: async (env) => {
    const { provider, apiKey } = env.ai!
    if (provider === 'openai') {
      return statusDetail(
        await httpStatus('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${apiKey}` } }),
      )
    }
    const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 })
    try {
      const page = await client.models.list({ limit: 1 })
      return { ok: true, detail: `models API reachable (${page.data.length ? 'models listed' : 'no models listed'})` }
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) return { ok: false, detail: 'HTTP 401 (credential rejected)' }
      if (error instanceof Anthropic.PermissionDeniedError) return { ok: false, detail: 'HTTP 403 (permission denied)' }
      if (error instanceof Anthropic.APIError) return { ok: false, detail: `HTTP ${error.status ?? 'error'}` }
      throw error
    }
  },

  email: async (env) => {
    const { resendApiKey, from } = env.email!
    const headers = { authorization: `Bearer ${resendApiKey}`, 'content-type': 'application/json' }
    if (sendTestEmail) {
      // Resend's test address accepts mail without delivering it anywhere.
      return statusDetail(
        await httpStatus('https://api.resend.com/emails', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            from,
            to: ['delivered@resend.dev'],
            subject: 'Nexefiy environment check',
            text: 'Test message sent by npm run env:check.',
          }),
        }),
      )
    }
    const response = await fetch('https://api.resend.com/domains', {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.ok) {
      await response.body?.cancel()
      return { ok: true, detail: `HTTP ${response.status} (full-access key)` }
    }
    const body = (await response.json().catch(() => ({}))) as { name?: unknown }
    if (body.name === 'restricted_api_key') {
      return { ok: true, detail: 'key accepted (sending-access key; use --send-test-email to test delivery)' }
    }
    return statusDetail(response.status)
  },

  billing: async (env) =>
    statusDetail(
      await httpStatus('https://api.stripe.com/v1/balance', {
        headers: { authorization: `Bearer ${env.billing!.secretKey}` },
      }),
    ),
}

const NO_CHECK: Partial<Record<FeatureKey, string>> = {
  contactForm: 'local only — messages are delivered with the email feature',
  credentialEncryption: 'local only — keyring parsed and validated',
  googleIntegration: 'format only — verified by completing an OAuth connection',
  slackIntegration: 'format only — verified by completing an OAuth connection',
  hubspotIntegration: 'format only — verified by completing an OAuth connection',
  backgroundJobs: 'format only — verified by `npx trigger.dev dev`',
  errorMonitoring: 'format only — verified by sending a test event from Sentry',
  cronAuth: 'local only — no provider to contact',
}

async function runConnectivity(snapshot: EnvironmentSnapshot): Promise<number> {
  console.log('\nConnectivity (read-only)')
  let failures = 0
  for (const feature of Object.values(snapshot.features)) {
    if (!feature.configured) continue
    const check = CHECKS[feature.key]
    if (!check) {
      console.log(`  - ${feature.label}: ${NO_CHECK[feature.key] ?? 'no check available'}`)
      continue
    }
    try {
      const result = await check(snapshot.env)
      if (!result.ok) failures++
      console.log(`  ${result.ok ? '✔' : '✖'} ${feature.label}: ${result.detail}`)
    } catch (error) {
      failures++
      const reason = error instanceof Error ? error.name : 'error'
      console.log(`  ✖ ${feature.label}: request failed (${reason})`)
    }
  }
  return failures
}

async function main(): Promise<number> {
  const { env, sources } = loadEnv()
  let snapshot: EnvironmentSnapshot
  try {
    snapshot = parseEnvironment(env)
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message)
      return 1
    }
    throw error
  }

  console.log(`Nexefiy environment check — ${snapshot.appEnv}`)
  console.log(`Sources: process environment${sources.length ? `, ${sources.join(', ')}` : ''}\n`)
  for (const feature of Object.values(snapshot.features)) printFeature(feature, env)

  const counts = Object.values(snapshot.features).reduce<Record<string, number>>((acc, f) => {
    acc[f.state] = (acc[f.state] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `\n${counts.configured ?? 0} configured, ${counts.not_configured ?? 0} not configured, ` +
      `${counts.misconfigured ?? 0} misconfigured, ${counts.blocked ?? 0} blocked ` +
      `(of ${Object.keys(FEATURES).length} features)`,
  )

  console.log(`\nURLs to register with providers for ${snapshot.env.core.appUrl}:`)
  for (const endpoint of PROVIDER_ENDPOINTS) {
    console.log(`  ${`${endpoint.provider} ${endpoint.kind}`.padEnd(46)} ${absoluteUrl(snapshot.env.core.appUrl, endpoint.path)}`)
  }

  let exitCode = 0
  if (strict && ((counts.misconfigured ?? 0) > 0 || (counts.blocked ?? 0) > 0)) exitCode = 1
  if (connectivity && (await runConnectivity(snapshot)) > 0) exitCode = 1
  return exitCode
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`env check failed: ${error instanceof Error ? error.name : 'unknown error'}`)
    process.exit(1)
  },
)

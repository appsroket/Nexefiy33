// Test doubles for integration code: a recording fetch that answers with
// provider-shaped responses, and an IntegrationRuntime over FakeSupabase.
//
// Provider responses used in tests are written from the providers' published
// documentation (contract fixtures). They prove the code sends what the docs
// describe and handles what the docs say comes back — not that a live account
// accepts it (docs/known-limitations.md).

import { parseKeyring } from '@/lib/crypto/keyring'
import type { AdminClient } from '@/lib/supabase/admin'
import type { TokenSet } from '@/modules/integrations/connectors/types'
import { storeTokens } from '@/modules/integrations/server/credentials'
import type { FetchLike } from '@/modules/integrations/server/http'
import type { IntegrationRuntime } from '@/modules/integrations/server/runtime'

import { testKey } from './env-fixtures'
import type { FakeSupabase } from './fake-supabase'

export const ORG = '11111111-1111-4111-8111-111111111111'
export const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
export const USER = '66666666-6666-4666-8666-666666666666'
export const HUBSPOT_ID = 'a4000000-0000-4000-8000-000000000001'
export const SLACK_ID = 'a4000000-0000-4000-8000-000000000002'
export const NOW = new Date('2026-10-18T12:00:00Z')

/** Low-entropy fake tokens assembled at runtime (never realistic-looking). */
export const fakeToken = (label: string) => `test-${label}-${'f'.repeat(16)}`

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
  json(): unknown
  form(): Record<string, string>
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** A fetch that records requests and answers with the first responder whose prefix matches. */
export function recordingFetch(routes: [prefix: string, responder: Responder | Responder[]][]) {
  const requests: RecordedRequest[] = []
  const queues = new Map(routes.map(([prefix, responder]) => [prefix, Array.isArray(responder) ? [...responder] : responder]))
  const fetch: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]))
    const body = typeof init.body === 'string' ? init.body : undefined
    const request: RecordedRequest = {
      url: input,
      method: init.method ?? 'GET',
      headers,
      body,
      json: () => JSON.parse(body ?? 'null'),
      form: () => Object.fromEntries(new URLSearchParams(body ?? '')),
    }
    requests.push(request)
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    for (const [prefix, responder] of queues) {
      if (!input.startsWith(prefix)) continue
      if (Array.isArray(responder)) {
        const next = responder.length > 1 ? responder.shift()! : responder[0]
        if (!next) break
        return next(request)
      }
      return responder(request)
    }
    throw new Error(`unexpected request to ${input}`)
  }
  return { fetch, requests }
}

export function testRuntime(db: FakeSupabase, fetch: FetchLike, options: { now?: () => Date } = {}) {
  const sleeps: number[] = []
  const runtime: IntegrationRuntime = {
    admin: db as unknown as AdminClient,
    fetch,
    keyring: parseKeyring(`k1:${testKey(7)}`, 'k1'),
    appUrl: 'https://app.example.test',
    oauthClient: () => ({ clientId: 'client-id-test', clientSecret: `client-secret-${'f'.repeat(8)}` }),
    now: options.now ?? (() => NOW),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
  return { runtime, sleeps }
}

export interface SeedOptions {
  id?: string
  organizationId?: string
  provider: 'hubspot' | 'slack'
  status?: string
  scopes: string[]
  tokens?: TokenSet | null
  metadata?: Record<string, unknown>
  externalAccountId?: string
}

/** A connection row plus encrypted tokens, as the OAuth callback leaves them. */
export async function seedConnection(db: FakeSupabase, runtime: IntegrationRuntime, options: SeedOptions) {
  const id = options.id ?? (options.provider === 'hubspot' ? HUBSPOT_ID : SLACK_ID)
  const organizationId = options.organizationId ?? ORG
  ;(db.tables.integrations ??= []).push({
    id,
    organization_id: organizationId,
    provider: options.provider,
    display_name: options.provider === 'hubspot' ? 'example.hubspot.com' : 'Example Workspace',
    status: options.status ?? 'connected',
    external_account_id: options.externalAccountId ?? (options.provider === 'hubspot' ? '123456' : 'T0001'),
    external_account_label: options.provider === 'hubspot' ? 'example.hubspot.com' : 'Example Workspace',
    granted_scopes: options.scopes,
    provider_metadata: options.metadata ?? (options.provider === 'hubspot' ? { hubId: '123456' } : { teamId: 'T0001', enterpriseInstall: false }),
    health_status: 'healthy',
    connected_at: NOW.toISOString(),
  })
  if (options.tokens !== null) {
    await storeTokens(runtime, { id, organizationId }, options.tokens ?? { accessToken: fakeToken('access'), scopes: options.scopes })
  }
  return id
}

export const HUBSPOT_SCOPES = ['oauth', 'crm.objects.contacts.read', 'crm.objects.contacts.write']
export const SLACK_SCOPES = ['channels:read', 'chat:write']

/** Rate-limit RPC that always allows (override per test to refuse). */
export function allowRateLimits(db: FakeSupabase) {
  db.rpcHandlers.consume_integration_rate_limit = () => ({ data: [{ allowed: true, retry_after_ms: 0 }], error: null })
}

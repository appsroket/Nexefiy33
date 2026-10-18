// Connecting (OAuth state and code exchange), encrypted credential storage,
// token renewal, health checks and disconnection, with an in-memory database
// and a fake provider built from documented responses.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { decryptCredential } from '@/lib/crypto/credential-encryption'
import { hubspotConnector } from '@/modules/integrations/connectors/hubspot'
import { slackConnector } from '@/modules/integrations/connectors/slack'
import { checkHealth, disconnect } from '@/modules/integrations/server/connections'
import { getAccessToken, loadTokens } from '@/modules/integrations/server/credentials'
import { requestAction } from '@/modules/integrations/server/executor'
import { AuthorizationError, completeAuthorization, hashState, startAuthorization } from '@/modules/integrations/server/oauth'

import { FakeSupabase } from '../helpers/fake-supabase'
import {
  allowRateLimits,
  fakeToken,
  HUBSPOT_ID,
  HUBSPOT_SCOPES,
  jsonResponse,
  NOW,
  ORG,
  recordingFetch,
  seedConnection,
  SLACK_ID,
  SLACK_SCOPES,
  testRuntime,
  USER,
  type Responder,
} from '../helpers/integration-fixtures'

let db: FakeSupabase

beforeEach(() => {
  db = new FakeSupabase()
  db.uniqueKeys.tasks = [['organization_id', 'idempotency_key']]
  db.uniqueKeys.tool_executions = [['organization_id', 'idempotency_key']]
  allowRateLimits(db)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function setup(routes: [string, Responder | Responder[]][] = [], now?: () => Date) {
  const recorder = recordingFetch(routes)
  const { runtime, sleeps } = testRuntime(db, recorder.fetch, now ? { now } : {})
  return { runtime, sleeps, requests: recorder.requests }
}

const slackExchange: Responder = () =>
  jsonResponse(200, {
    ok: true,
    access_token: fakeToken('bot'),
    token_type: 'bot',
    scope: 'channels:read,chat:write',
    bot_user_id: 'U0BOT',
    app_id: 'A0APP',
    team: { name: 'Example Workspace', id: 'T0001' },
    is_enterprise_install: false,
  })

async function begin(runtime: ReturnType<typeof setup>['runtime'], options: { integrationId?: string } = {}) {
  const url = new URL(await startAuthorization(runtime, slackConnector, { organizationId: ORG, userId: USER, ...options }))
  return { url, state: url.searchParams.get('state')! }
}

describe('starting a connection', () => {
  it('sends the browser to the provider with minimal scopes and stores only a hash of the state', async () => {
    const { runtime } = setup()
    const { url, state } = await begin(runtime)
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(url.searchParams.get('scope')).toBe('channels:read,chat:write')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.test/api/integrations/slack/callback')
    expect(url.searchParams.get('client_id')).toBe('client-id-test')
    expect(url.toString()).not.toContain('client-secret')
    expect(state.length).toBeGreaterThanOrEqual(43)

    const stored = db.tables.integration_oauth_states![0]!
    expect(stored).toMatchObject({ organization_id: ORG, user_id: USER, provider: 'slack', state_sha256: hashState(state) })
    expect(JSON.stringify(stored)).not.toContain(state)
    expect(Date.parse(stored.expires_at as string) - NOW.getTime()).toBe(10 * 60_000)
  })

  it('uses space-separated scopes for HubSpot, including its required oauth scope', async () => {
    const { runtime } = setup()
    const url = new URL(await startAuthorization(runtime, hubspotConnector, { organizationId: ORG, userId: USER }))
    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize')
    expect(url.searchParams.get('scope')).toBe('oauth crm.objects.contacts.read crm.objects.contacts.write')
  })
})

describe('completing a connection', () => {
  it('exchanges the code, encrypts the tokens, records the connection and its action settings', async () => {
    const { runtime, requests } = setup([['https://slack.com/api/oauth.v2.access', slackExchange]])
    const { state } = await begin(runtime)
    const result = await completeAuthorization(runtime, slackConnector, { state, code: 'code-1', userId: USER })

    expect(result).toMatchObject({ organizationId: ORG, returnPath: '/app/integrations', reconnected: false })
    expect(requests[0]!.form()).toMatchObject({ code: 'code-1', redirect_uri: 'https://app.example.test/api/integrations/slack/callback' })

    const connection = db.tables.integrations![0]!
    expect(connection).toMatchObject({
      id: result.integrationId,
      organization_id: ORG,
      provider: 'slack',
      status: 'connected',
      external_account_id: 'T0001',
      granted_scopes: ['channels:read', 'chat:write'],
      connected_by: USER,
      health_status: 'healthy',
    })

    const secret = db.tables.integration_secrets![0]!
    expect(secret).toMatchObject({ integration_id: result.integrationId, organization_id: ORG, secret_kind: 'oauth_tokens', key_id: 'k1' })
    expect(secret.ciphertext as string).toMatch(/^nxf1\.k1\./)
    expect(secret.ciphertext as string).not.toContain(fakeToken('bot'))
    expect(JSON.stringify(db.tables.integrations)).not.toContain(fakeToken('bot'))
    // Bound to this organization and connection: decrypting with another context fails.
    const context = { organizationId: ORG, connectionId: result.integrationId, purpose: 'oauth_tokens' }
    expect(JSON.parse(decryptCredential(runtime.keyring, secret.ciphertext as string, context)).accessToken).toBe(fakeToken('bot'))
    expect(() => decryptCredential(runtime.keyring, secret.ciphertext as string, { ...context, organizationId: '22222222-2222-4222-8222-222222222222' })).toThrow()

    expect(db.tables.integration_actions).toEqual([
      expect.objectContaining({ action_key: 'slack.channels.list', risk_level: 'read', approval_mode: 'allow', organization_id: ORG }),
      expect.objectContaining({ action_key: 'slack.messages.post', risk_level: 'write_external', approval_mode: 'require_approval' }),
    ])
    expect(db.tables.audit_logs![0]).toMatchObject({ action: 'integration.connected', actor_user_id: USER, organization_id: ORG })
    expect(JSON.stringify(db.tables.audit_logs)).not.toContain(fakeToken('bot'))
  })

  it('accepts a state only once, only for the user who started it, and only before it expires', async () => {
    const { runtime } = setup([['https://slack.com/api/oauth.v2.access', slackExchange]])
    const { state } = await begin(runtime)
    await expect(completeAuthorization(runtime, slackConnector, { state, code: 'c', userId: '77777777-7777-4777-8777-777777777777' })).rejects.toMatchObject({ reason: 'invalid_state' })
    await expect(completeAuthorization(runtime, hubspotConnector, { state, code: 'c', userId: USER })).rejects.toMatchObject({ reason: 'invalid_state' })
    await completeAuthorization(runtime, slackConnector, { state, code: 'c', userId: USER })
    await expect(completeAuthorization(runtime, slackConnector, { state, code: 'c', userId: USER })).rejects.toBeInstanceOf(AuthorizationError)

    const later = setup([['https://slack.com/api/oauth.v2.access', slackExchange]], () => new Date(NOW.getTime() + 11 * 60_000))
    const expired = await begin(setup().runtime)
    await expect(completeAuthorization(later.runtime, slackConnector, { state: expired.state, code: 'c', userId: USER })).rejects.toMatchObject({ reason: 'invalid_state' })
  })

  it('reuses the connection when the same account is connected again', async () => {
    const { runtime } = setup([['https://slack.com/api/oauth.v2.access', slackExchange]])
    const first = await completeAuthorization(runtime, slackConnector, { state: (await begin(runtime)).state, code: 'c', userId: USER })
    db.tables.integrations![0]!.status = 'revoked'
    const second = await completeAuthorization(runtime, slackConnector, { state: (await begin(runtime)).state, code: 'c', userId: USER })
    expect(second).toMatchObject({ integrationId: first.integrationId, reconnected: true })
    expect(db.tables.integrations).toHaveLength(1)
    expect(db.tables.integrations![0]).toMatchObject({ status: 'connected', revoked_at: null })
  })

  it('refuses a reconnection that authorizes a different account', async () => {
    const { runtime } = setup([['https://slack.com/api/oauth.v2.access', slackExchange]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES, externalAccountId: 'T9999' })
    const { state } = await begin(runtime, { integrationId: SLACK_ID })
    await expect(completeAuthorization(runtime, slackConnector, { state, code: 'c', userId: USER })).rejects.toMatchObject({ reason: 'different_account' })
  })

  it('reports a failed exchange without saving anything', async () => {
    const { runtime } = setup([['https://slack.com/api/oauth.v2.access', () => jsonResponse(200, { ok: false, error: 'invalid_code' })]])
    await expect(completeAuthorization(runtime, slackConnector, { state: (await begin(runtime)).state, code: 'bad', userId: USER })).rejects.toMatchObject({ reason: 'exchange_failed' })
    expect(db.tables.integrations ?? []).toHaveLength(0)
    expect(db.tables.integration_secrets ?? []).toHaveLength(0)
  })
})

describe('token renewal', () => {
  const expiring = { accessToken: fakeToken('old'), refreshToken: fakeToken('refresh'), expiresAt: '2026-10-18T12:01:00Z', scopes: HUBSPOT_SCOPES }

  it('renews a token about to expire and stores the new one encrypted', async () => {
    const { runtime, requests } = setup([['https://api.hubapi.com/oauth/2026-03/token', () => jsonResponse(200, { access_token: fakeToken('new'), expires_in: 1800 })]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES, tokens: expiring })
    expect(await getAccessToken(runtime, hubspotConnector, { id: HUBSPOT_ID, organizationId: ORG })).toBe(fakeToken('new'))
    expect(requests).toHaveLength(1)
    expect(await loadTokens(runtime, { id: HUBSPOT_ID, organizationId: ORG })).toMatchObject({ accessToken: fakeToken('new'), refreshToken: fakeToken('refresh') })
    expect(db.tables.integration_secrets![0]!.refresh_lease_until).toBeNull()
  })

  it('leaves a token with plenty of life alone', async () => {
    const { runtime, requests } = setup()
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES, tokens: { ...expiring, expiresAt: '2026-10-18T12:30:00Z' } })
    expect(await getAccessToken(runtime, hubspotConnector, { id: HUBSPOT_ID, organizationId: ORG })).toBe(fakeToken('old'))
    expect(requests).toHaveLength(0)
  })

  it('waits for another server’s renewal instead of renewing twice', async () => {
    const { runtime, requests } = setup()
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES, tokens: expiring })
    db.tables.integration_secrets![0]!.refresh_lease_until = '2026-10-18T12:00:20Z'
    // The other server finishes while we wait.
    runtime.sleep = async () => {
      const { storeTokens } = await import('@/modules/integrations/server/credentials')
      await storeTokens(runtime, { id: HUBSPOT_ID, organizationId: ORG }, { ...expiring, accessToken: fakeToken('theirs'), expiresAt: '2026-10-18T12:30:00Z' })
    }
    expect(await getAccessToken(runtime, hubspotConnector, { id: HUBSPOT_ID, organizationId: ORG })).toBe(fakeToken('theirs'))
    expect(requests).toHaveLength(0)
  })

  it('asks for reconnection when an expired token has no refresh token', async () => {
    const { runtime } = setup()
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES, tokens: { accessToken: 'x', expiresAt: '2026-10-18T11:00:00Z', scopes: [] } })
    await expect(getAccessToken(runtime, slackConnector, { id: SLACK_ID, organizationId: ORG })).rejects.toMatchObject({ code: 'reauth_required' })
  })

  it('treats credentials that fail to decrypt as needing reconnection', async () => {
    const { runtime } = setup()
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    db.tables.integration_secrets![0]!.organization_id = ORG
    db.tables.integration_secrets![0]!.ciphertext = 'nxf1.k1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'
    await expect(loadTokens(runtime, { id: SLACK_ID, organizationId: ORG })).rejects.toMatchObject({ code: 'reauth_required' })
  })
})

describe('health checks', () => {
  it('records a healthy check and the scopes Slack reports', async () => {
    const { runtime } = setup([['https://slack.com/api/auth.test', () => jsonResponse(200, { ok: true, team: 'Example', team_id: 'T0001' }, { 'x-oauth-scopes': 'channels:read,chat:write' })]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: [] })
    expect(await checkHealth(runtime, ORG, SLACK_ID)).toMatchObject({ status: 'healthy' })
    expect(db.tables.integrations![0]).toMatchObject({ health_status: 'healthy', last_health_check_at: NOW.toISOString(), granted_scopes: SLACK_SCOPES })
  })

  it('marks a connection whose token was revoked at the provider for reconnection', async () => {
    const { runtime } = setup([['https://slack.com/api/auth.test', () => jsonResponse(200, { ok: false, error: 'token_revoked' })]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    expect((await checkHealth(runtime, ORG, SLACK_ID)).status).toBe('unhealthy')
    expect(db.tables.integrations![0]).toMatchObject({ status: 'needs_reauth', health_status: 'unhealthy' })
  })

  it('reports a provider outage as degraded without disconnecting', async () => {
    const { runtime } = setup([['https://slack.com/api/auth.test', () => jsonResponse(503, 'down')]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    expect((await checkHealth(runtime, ORG, SLACK_ID)).status).toBe('degraded')
    expect(db.tables.integrations![0]!.status).toBe('connected')
  })

  it('cannot check another organization’s connection', async () => {
    const { runtime } = setup()
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES, organizationId: '22222222-2222-4222-8222-222222222222' })
    await expect(checkHealth(runtime, ORG, SLACK_ID)).rejects.toMatchObject({ code: 'not_connected' })
  })
})

describe('disconnecting', () => {
  it('revokes at the provider, deletes credentials, cancels pending actions, and then refuses to run actions', async () => {
    const { runtime, requests } = setup([['https://slack.com/api/auth.revoke', () => jsonResponse(200, { ok: true, revoked: true })]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    const waiting = await requestAction(runtime, {
      organizationId: ORG,
      integrationId: SLACK_ID,
      actionKey: 'slack.messages.post',
      input: { channel: 'C0123456789', text: 'Queued' },
      idempotencyKey: 'k1',
      actor: { kind: 'user', userId: USER, role: 'admin' },
    })
    expect(waiting.status).toBe('awaiting_approval')

    const result = await disconnect(runtime, { organizationId: ORG, integrationId: SLACK_ID, userId: USER })
    expect(result).toEqual({ revocation: 'revoked', cancelledExecutions: 1 })
    expect(requests[0]).toMatchObject({ url: 'https://slack.com/api/auth.revoke', headers: expect.objectContaining({ authorization: `Bearer ${fakeToken('access')}` }) })
    expect(db.tables.integration_secrets).toEqual([])
    expect(db.tables.integrations![0]).toMatchObject({ status: 'revoked', revoked_at: NOW.toISOString(), last_error: null })
    expect(db.tables.tool_executions![0]).toMatchObject({ status: 'cancelled' })
    expect(db.tables.approval_requests![0]).toMatchObject({ status: 'cancelled', decided_at: NOW.toISOString() })
    expect(db.tables.tasks![0]!.status).toBe('cancelled')
    expect(db.tables.audit_logs!.at(-1)).toMatchObject({ action: 'integration.disconnected', actor_user_id: USER, metadata: { revocation: 'revoked', cancelled_executions: 1, provider: 'slack' } })

    const after = await requestAction(runtime, {
      organizationId: ORG,
      integrationId: SLACK_ID,
      actionKey: 'slack.channels.list',
      input: {},
      idempotencyKey: 'k2',
      actor: { kind: 'user', userId: USER, role: 'admin' },
    })
    expect(after).toMatchObject({ status: 'refused', error: { code: 'not_connected' } })
    expect(requests).toHaveLength(1)
  })

  it('still disconnects locally when the provider can’t confirm revocation, and says so', async () => {
    const { runtime } = setup([['https://slack.com/api/auth.revoke', () => jsonResponse(503, 'down')]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    const result = await disconnect(runtime, { organizationId: ORG, integrationId: SLACK_ID, userId: USER })
    expect(result.revocation).toBe('failed')
    expect(db.tables.integration_secrets).toEqual([])
    expect(db.tables.integrations![0]).toMatchObject({ status: 'revoked', last_error: expect.stringContaining('couldn’t confirm revocation') })
  })

  it('treats a token the provider already rejects as revoked', async () => {
    const { runtime } = setup([['https://api.hubapi.com/oauth/2026-03/token/revoke', () => jsonResponse(400, { error: 'invalid_grant' })]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES, tokens: { accessToken: 'a', refreshToken: fakeToken('refresh'), scopes: [] } })
    expect((await disconnect(runtime, { organizationId: ORG, integrationId: HUBSPOT_ID, userId: USER })).revocation).toBe('revoked')
  })

  it('cannot disconnect another organization’s connection', async () => {
    const { runtime, requests } = setup()
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES, organizationId: '22222222-2222-4222-8222-222222222222' })
    await expect(disconnect(runtime, { organizationId: ORG, integrationId: SLACK_ID, userId: USER })).rejects.toMatchObject({ code: 'not_connected' })
    expect(db.tables.integration_secrets).toHaveLength(1)
    expect(requests).toHaveLength(0)
  })
})

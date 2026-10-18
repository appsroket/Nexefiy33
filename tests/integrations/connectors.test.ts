// Contract tests for the HubSpot and Slack connectors. The responses are
// fixtures written from each provider's published documentation (checked
// 2026-10-18), not recordings of a live account: they show the connectors
// send what the docs describe and normalize what the docs say comes back.
// Live verification is tracked in docs/known-limitations.md.

import { describe, expect, it } from 'vitest'

import { existingIdFromConflict, hubspotConnector, normalizeHubSpotError } from '@/modules/integrations/connectors/hubspot'
import { escapeSlackText, normalizeSlackError, slackConnector } from '@/modules/integrations/connectors/slack'
import type { ActionContext } from '@/modules/integrations/connectors/types'
import { IntegrationError } from '@/modules/integrations/domain/errors'
import { createHttpClient } from '@/modules/integrations/server/http'

import { fakeToken, jsonResponse, recordingFetch, type Responder } from '../helpers/integration-fixtures'

const client = { clientId: 'client-id-test', clientSecret: `client-secret-${'f'.repeat(8)}` }

function http(routes: [string, Responder | Responder[]][]) {
  const recorder = recordingFetch(routes)
  return { ...recorder, client: createHttpClient({ fetch: recorder.fetch, timeoutMs: 5_000, defaultBuckets: [] }) }
}

function context(httpClient: ActionContext['http'], metadata: Record<string, unknown> = { hubId: '123456' }, externalAccountId = '123456'): ActionContext {
  return {
    http: httpClient,
    accessToken: fakeToken('access'),
    connection: { id: 'conn', organizationId: 'org', externalAccountId, metadata },
    signal: new AbortController().signal,
  }
}

function action(connector: typeof hubspotConnector, key: string) {
  return connector.actions.find((candidate) => candidate.key === key)!
}

const contact = (id: string, email: string) => ({
  id,
  properties: { email, firstname: 'Dana', lastname: 'Lee', company: null, lastmodifieddate: '2026-10-18T10:00:00Z' },
})

async function rejection(promise: Promise<unknown>): Promise<IntegrationError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof IntegrationError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('HubSpot OAuth', () => {
  it('exchanges the code with form-encoded credentials and identifies the account by introspection', async () => {
    const { client: httpClient, requests } = http([
      [
        'https://api.hubapi.com/oauth/2026-03/token/introspect',
        () => jsonResponse(200, { hub_id: 123456, hub_domain: 'example.hubspot.com', scopes: ['oauth', 'crm.objects.contacts.read'] }),
      ],
      [
        'https://api.hubapi.com/oauth/2026-03/token',
        () => jsonResponse(200, { access_token: fakeToken('access'), refresh_token: fakeToken('refresh'), expires_in: 1800, token_type: 'bearer' }),
      ],
    ])
    const result = await hubspotConnector.auth.exchangeCode(httpClient, client, { code: 'code-1', redirectUri: 'https://app.example.test/api/integrations/hubspot/callback' })

    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.url).toBe('https://api.hubapi.com/oauth/2026-03/token')
    expect(requests[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(requests[0]!.form()).toEqual({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: 'https://app.example.test/api/integrations/hubspot/callback',
      code: 'code-1',
    })
    expect(requests[0]!.url).not.toContain('client_secret')
    expect(requests[1]!.form()).toMatchObject({ token: fakeToken('access'), token_type_hint: 'access_token' })
    expect(result.account).toEqual({
      externalAccountId: '123456',
      label: 'example.hubspot.com',
      metadata: { hubId: '123456', hubDomain: 'example.hubspot.com' },
      scopes: ['oauth', 'crm.objects.contacts.read'],
    })
    expect(result.tokens).toMatchObject({ accessToken: fakeToken('access'), refreshToken: fakeToken('refresh') })
    expect(Date.parse(result.tokens.expiresAt!)).toBeGreaterThan(Date.now() + 1_700_000)
  })

  it('refreshes with the refresh token and keeps it when HubSpot does not return a new one', async () => {
    const { client: httpClient, requests } = http([
      ['https://api.hubapi.com/oauth/2026-03/token', () => jsonResponse(200, { access_token: fakeToken('new'), expires_in: 1800 })],
    ])
    const tokens = await hubspotConnector.auth.refresh(httpClient, client, fakeToken('refresh'))
    expect(requests[0]!.form()).toMatchObject({ grant_type: 'refresh_token', refresh_token: fakeToken('refresh') })
    expect(tokens).toMatchObject({ accessToken: fakeToken('new'), refreshToken: fakeToken('refresh') })
  })

  it('maps a rejected refresh token to "reconnect"', async () => {
    const { client: httpClient } = http([
      ['https://api.hubapi.com/oauth/2026-03/token', () => jsonResponse(400, { status: 'BAD_REFRESH_TOKEN', message: 'missing or unknown refresh token', error: 'invalid_grant', error_description: 'missing or unknown refresh token' })],
    ])
    expect((await rejection(hubspotConnector.auth.refresh(httpClient, client, 'x'))).code).toBe('reauth_required')
  })

  it('revokes the refresh token', async () => {
    const { client: httpClient, requests } = http([['https://api.hubapi.com/oauth/2026-03/token/revoke', () => new Response(null, { status: 204 })]])
    await hubspotConnector.auth.revoke(httpClient, client, { accessToken: 'a', refreshToken: fakeToken('refresh'), scopes: [] })
    expect(requests[0]!.form()).toMatchObject({ token: fakeToken('refresh'), token_type_hint: 'refresh_token' })
  })
})

describe('HubSpot errors', () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers), body })

  it('normalizes documented error responses', () => {
    expect(normalizeHubSpotError(response(401, { status: 'error', message: 'Authentication credentials not found.', category: 'INVALID_AUTHENTICATION', correlationId: 'c-1' }))).toMatchObject({
      code: 'reauth_required',
      correlationId: 'c-1',
    })
    expect(normalizeHubSpotError(response(403, { status: 'error', category: 'MISSING_SCOPES', message: 'This app hasn’t been granted all required scopes' })).code).toBe('insufficient_scope')
    expect(normalizeHubSpotError(response(400, { status: 'error', category: 'VALIDATION_ERROR', message: 'Property values were not valid' })).code).toBe('invalid_input')
    expect(normalizeHubSpotError(response(404, { status: 'error', category: 'OBJECT_NOT_FOUND' })).code).toBe('not_found')
    expect(normalizeHubSpotError(response(502, 'Bad gateway'))).toMatchObject({ code: 'unavailable', retryable: true })
  })

  it('treats the ten-second limit as retryable and the daily limit as not', () => {
    const secondly = normalizeHubSpotError(response(429, { status: 'error', policyName: 'TEN_SECONDLY_ROLLING', category: 'RATE_LIMITS' }))
    expect(secondly).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 10_000, providerCode: 'TEN_SECONDLY_ROLLING' })
    expect(normalizeHubSpotError(response(429, {}, { 'retry-after': '2' })).retryAfterMs).toBe(2000)
    expect(normalizeHubSpotError(response(429, { policyName: 'DAILY' })).retryable).toBe(false)
  })

  it('reads the existing contact id from a 409 conflict', () => {
    const conflict = normalizeHubSpotError(response(409, { status: 'error', message: 'Contact already exists. Existing ID: 5101', category: 'CONFLICT' }))
    expect(conflict.code).toBe('conflict')
    expect(existingIdFromConflict(conflict)).toBe('5101')
  })
})

describe('HubSpot actions', () => {
  it('searches by exact email with a filter group and the search rate-limit bucket', async () => {
    const { client: httpClient, requests } = http([
      ['https://api.hubapi.com/crm/objects/2026-09/contacts/search', () => jsonResponse(200, { total: 1, results: [contact('501', 'dana@example.com')] })],
    ])
    const search = action(hubspotConnector, 'hubspot.contacts.search')
    const output = await search.execute(context(httpClient), search.input.parse({ email: 'Dana@Example.com' }))
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${fakeToken('access')}`)
    expect(requests[0]!.json()).toMatchObject({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'dana@example.com' }] }], limit: 5 })
    expect(output).toEqual({
      total: 1,
      contacts: [expect.objectContaining({ id: '501', email: 'dana@example.com', url: 'https://app.hubspot.com/contacts/123456/record/0-1/501' })],
    })
    expect(search.output.safeParse(output).success).toBe(true)
  })

  it('updates the existing contact with the same email, sending only given fields', async () => {
    const { client: httpClient, requests } = http([
      ['https://api.hubapi.com/crm/objects/2026-09/contacts/search', () => jsonResponse(200, { total: 1, results: [contact('501', 'dana@example.com')] })],
      ['https://api.hubapi.com/crm/objects/2026-09/contacts/501', () => jsonResponse(200, contact('501', 'dana@example.com'))],
    ])
    const upsert = action(hubspotConnector, 'hubspot.contacts.upsert')
    const output = await upsert.execute(context(httpClient), upsert.input.parse({ email: 'dana@example.com', company: 'Example Co' }))
    expect(requests[1]!.method).toBe('PATCH')
    expect(requests[1]!.json()).toEqual({ properties: { company: 'Example Co' } })
    expect(output).toMatchObject({ id: '501', result: 'updated' })
  })

  it('creates a contact when none matches', async () => {
    const { client: httpClient, requests } = http([
      ['https://api.hubapi.com/crm/objects/2026-09/contacts/search', () => jsonResponse(200, { total: 0, results: [] })],
      ['https://api.hubapi.com/crm/objects/2026-09/contacts', () => jsonResponse(201, contact('777', 'new@example.com'))],
    ])
    const upsert = action(hubspotConnector, 'hubspot.contacts.upsert')
    const output = await upsert.execute(context(httpClient), upsert.input.parse({ email: 'new@example.com', firstName: 'New', lifecycleStage: 'lead' }))
    expect(requests[1]!.method).toBe('POST')
    expect(requests[1]!.json()).toEqual({ properties: { email: 'new@example.com', firstname: 'New', lifecyclestage: 'lead' } })
    expect(output).toMatchObject({ id: '777', result: 'created' })
  })

  it('updates instead when the create races an existing contact (search lag)', async () => {
    const { client: httpClient, requests } = http([
      ['https://api.hubapi.com/crm/objects/2026-09/contacts/search', () => jsonResponse(200, { total: 0, results: [] })],
      ['https://api.hubapi.com/crm/objects/2026-09/contacts/5101', () => jsonResponse(200, contact('5101', 'dana@example.com'))],
      ['https://api.hubapi.com/crm/objects/2026-09/contacts', () => jsonResponse(409, { status: 'error', message: 'Contact already exists. Existing ID: 5101', category: 'CONFLICT' })],
    ])
    const upsert = action(hubspotConnector, 'hubspot.contacts.upsert')
    const output = await upsert.execute(context(httpClient), upsert.input.parse({ email: 'dana@example.com', lastName: 'Lee' }))
    expect(requests.map((request) => request.method)).toEqual(['POST', 'POST', 'PATCH'])
    expect(output).toMatchObject({ id: '5101', result: 'updated' })
  })

  it('adds a note as escaped text associated to the contact (type 202)', async () => {
    const { client: httpClient, requests } = http([['https://api.hubapi.com/crm/objects/2026-09/notes', () => jsonResponse(201, { id: '9001', properties: {} })]])
    const note = action(hubspotConnector, 'hubspot.notes.create')
    const output = await note.execute(context(httpClient), note.input.parse({ contactId: '501', body: 'Wants <b>20</b> seats\nCall Friday' }))
    const body = requests[0]!.json() as { properties: Record<string, string>; associations: unknown[] }
    expect(body.properties.hs_note_body).toBe('Wants &lt;b&gt;20&lt;/b&gt; seats<br>Call Friday')
    expect(body.properties.hs_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(body.associations).toEqual([{ to: { id: '501' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }])
    expect(output).toEqual({ id: '9001', contactId: '501', url: 'https://app.hubspot.com/contacts/123456/record/0-1/501' })
  })

  it('validates inputs before anything is sent', () => {
    expect(action(hubspotConnector, 'hubspot.contacts.search').input.safeParse({}).success).toBe(false)
    expect(action(hubspotConnector, 'hubspot.contacts.upsert').input.safeParse({ email: 'not-an-email' }).success).toBe(false)
    expect(action(hubspotConnector, 'hubspot.notes.create').input.safeParse({ contactId: '../1', body: 'x' }).success).toBe(false)
  })

  it('checks health with a one-record contacts read', async () => {
    const { client: httpClient, requests } = http([['https://api.hubapi.com/crm/objects/2026-09/contacts?limit=1', () => jsonResponse(200, { results: [] })]])
    expect(await hubspotConnector.healthCheck(context(httpClient))).toMatchObject({ status: 'healthy' })
    expect(requests[0]!.method).toBe('GET')
  })
})

describe('Slack OAuth', () => {
  it('exchanges the code with HTTP Basic client authentication and records the workspace', async () => {
    const { client: httpClient, requests } = http([
      [
        'https://slack.com/api/oauth.v2.access',
        () =>
          jsonResponse(200, {
            ok: true,
            access_token: fakeToken('bot'),
            token_type: 'bot',
            scope: 'channels:read,chat:write',
            bot_user_id: 'U0BOT',
            app_id: 'A0APP',
            team: { name: 'Example Workspace', id: 'T0001' },
            enterprise: null,
            authed_user: { id: 'U0001' },
            is_enterprise_install: false,
          }),
      ],
    ])
    const result = await slackConnector.auth.exchangeCode(httpClient, client, { code: 'code-1', redirectUri: 'https://app.example.test/api/integrations/slack/callback' })
    expect(requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`)
    expect(requests[0]!.form()).toEqual({ code: 'code-1', redirect_uri: 'https://app.example.test/api/integrations/slack/callback' })
    expect(requests[0]!.body).not.toContain('client_secret')
    expect(result.account).toMatchObject({ externalAccountId: 'T0001', label: 'Example Workspace', scopes: ['channels:read', 'chat:write'] })
    expect(result.account.metadata).toMatchObject({ teamId: 'T0001', botUserId: 'U0BOT', enterpriseInstall: false })
    expect(result.tokens.expiresAt).toBeUndefined()
  })

  it('uses the enterprise as the account for org-wide installs', async () => {
    const { client: httpClient } = http([
      ['https://slack.com/api/oauth.v2.access', () => jsonResponse(200, { ok: true, access_token: fakeToken('bot'), scope: 'chat:write', team: null, enterprise: { id: 'E0001', name: 'Example Grid' }, is_enterprise_install: true })],
    ])
    const result = await slackConnector.auth.exchangeCode(httpClient, client, { code: 'c', redirectUri: 'r' })
    expect(result.account).toMatchObject({ externalAccountId: 'E0001', label: 'Example Grid' })
  })

  it('refreshes rotating tokens and stores the new refresh token', async () => {
    const { client: httpClient, requests } = http([
      ['https://slack.com/api/oauth.v2.access', () => jsonResponse(200, { ok: true, access_token: fakeToken('new'), refresh_token: fakeToken('refresh2'), expires_in: 43200, scope: 'chat:write' })],
    ])
    const tokens = await slackConnector.auth.refresh(httpClient, client, fakeToken('refresh1'))
    expect(requests[0]!.form()).toEqual({ grant_type: 'refresh_token', refresh_token: fakeToken('refresh1') })
    expect(tokens).toMatchObject({ accessToken: fakeToken('new'), refreshToken: fakeToken('refresh2') })
  })

  it('revokes with auth.revoke and requires Slack to confirm it', async () => {
    const confirmed = http([['https://slack.com/api/auth.revoke', () => jsonResponse(200, { ok: true, revoked: true })]])
    await slackConnector.auth.revoke(confirmed.client, client, { accessToken: fakeToken('bot'), scopes: [] })
    expect(confirmed.requests[0]!.headers.authorization).toBe(`Bearer ${fakeToken('bot')}`)

    const unconfirmed = http([['https://slack.com/api/auth.revoke', () => jsonResponse(200, { ok: true, revoked: false })]])
    expect((await rejection(slackConnector.auth.revoke(unconfirmed.client, client, { accessToken: 'x', scopes: [] }))).code).toBe('provider_error')
  })
})

describe('Slack errors and actions', () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers), body })

  it('normalizes ok:false errors and HTTP 429', () => {
    expect(normalizeSlackError(response(200, { ok: false, error: 'invalid_auth' })).code).toBe('reauth_required')
    expect(normalizeSlackError(response(200, { ok: false, error: 'token_revoked' })).code).toBe('reauth_required')
    expect(normalizeSlackError(response(200, { ok: false, error: 'missing_scope', needed: 'chat:write' })).code).toBe('insufficient_scope')
    expect(normalizeSlackError(response(200, { ok: false, error: 'not_in_channel' }))).toMatchObject({ code: 'forbidden', message: expect.stringContaining('/invite') })
    expect(normalizeSlackError(response(200, { ok: false, error: 'channel_not_found' })).code).toBe('not_found')
    expect(normalizeSlackError(response(200, { ok: false, error: 'something_new' }))).toMatchObject({ code: 'provider_error', providerCode: 'something_new' })
    expect(normalizeSlackError(response(429, '', { 'retry-after': '30' }))).toMatchObject({ code: 'rate_limited', retryAfterMs: 30_000 })
    expect(normalizeSlackError(response(503, 'down')).code).toBe('unavailable')
  })

  it('escapes control characters so text cannot ping @channel or hide links', () => {
    expect(escapeSlackText('<!channel> & <https://evil.example|bank> <@U123>')).toBe('&lt;!channel&gt; &amp; &lt;https://evil.example|bank&gt; &lt;@U123&gt;')
  })

  it('posts plain text without unfurling, counted per channel', async () => {
    const { client: httpClient, requests } = http([['https://slack.com/api/chat.postMessage', () => jsonResponse(200, { ok: true, channel: 'C0123456789', ts: '1712345678.000100' })]])
    const post = action(slackConnector, 'slack.messages.post')
    const output = await post.execute(context(httpClient, { teamId: 'T0001' }, 'T0001'), post.input.parse({ channel: 'C0123456789', text: 'Hi <!here>' }))
    expect(requests[0]!.json()).toEqual({ channel: 'C0123456789', text: 'Hi &lt;!here&gt;', unfurl_links: false, unfurl_media: false })
    expect(requests[0]!.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(output).toEqual({ channel: 'C0123456789', ts: '1712345678.000100', threadTs: null })
  })

  it('accepts only channel ids, not names or user DMs', () => {
    const post = action(slackConnector, 'slack.messages.post')
    expect(post.input.safeParse({ channel: '#general', text: 'x' }).success).toBe(false)
    expect(post.input.safeParse({ channel: 'U0123456789', text: 'x' }).success).toBe(false)
    expect(post.input.safeParse({ channel: 'C0123456789', text: '' }).success).toBe(false)
  })

  it('lists public channels and filters by name', async () => {
    const { client: httpClient, requests } = http([
      [
        'https://slack.com/api/conversations.list',
        () =>
          jsonResponse(200, {
            ok: true,
            channels: [
              { id: 'C1', name: 'sales', is_private: false, is_member: true, num_members: 4 },
              { id: 'C2', name: 'random', is_private: false, is_member: false, num_members: 9 },
            ],
            response_metadata: { next_cursor: 'dGVhbTpDMDYxRkE1UEI=' },
          }),
      ],
    ])
    const list = action(slackConnector, 'slack.channels.list')
    const output = await list.execute(context(httpClient), list.input.parse({ nameContains: 'Sal' }))
    expect(requests[0]!.url).toContain('types=public_channel')
    expect(requests[0]!.url).toContain('exclude_archived=true')
    expect(output).toEqual({ channels: [{ id: 'C1', name: 'sales', isPrivate: false, isMember: true, memberCount: 4 }], nextCursor: 'dGVhbTpDMDYxRkE1UEI=' })
  })

  it('checks health with auth.test, reads granted scopes, and notices a different workspace', async () => {
    const same = http([['https://slack.com/api/auth.test', () => jsonResponse(200, { ok: true, team: 'Example', team_id: 'T0001' }, { 'x-oauth-scopes': 'channels:read,chat:write' })]])
    expect(await slackConnector.healthCheck(context(same.client, { enterpriseInstall: false }, 'T0001'))).toMatchObject({
      status: 'healthy',
      grantedScopes: ['channels:read', 'chat:write'],
    })
    const other = http([['https://slack.com/api/auth.test', () => jsonResponse(200, { ok: true, team: 'Other', team_id: 'T9999' })]])
    expect((await slackConnector.healthCheck(context(other.client, { enterpriseInstall: false }, 'T0001'))).status).toBe('degraded')
  })
})

describe('HTTP client', () => {
  it('turns timeouts into "timeout" (may have arrived) and refused connections into "unavailable" (not sent)', async () => {
    const slow = createHttpClient({
      fetch: (_input, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      timeoutMs: 20,
      defaultBuckets: [],
    })
    expect(await rejection(slow.send({ method: 'GET', url: 'https://example.test' }))).toMatchObject({ code: 'timeout', mayHaveReachedProvider: true })

    const refused = createHttpClient({
      fetch: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      },
      timeoutMs: 1000,
      defaultBuckets: [],
    })
    expect(await rejection(refused.send({ method: 'GET', url: 'https://example.test' }))).toMatchObject({ code: 'unavailable', mayHaveReachedProvider: false })
  })

  it('asks the rate-limit gate before sending, and does not send when refused', async () => {
    const recorder = recordingFetch([['https://example.test', () => jsonResponse(200, {})]])
    const gated = createHttpClient({
      fetch: recorder.fetch,
      timeoutMs: 1000,
      defaultBuckets: ['slack.default'],
      rateLimit: async (buckets) => {
        throw new IntegrationError('rate_limited', { message: buckets.join(','), mayHaveReachedProvider: false })
      },
    })
    expect((await rejection(gated.send({ method: 'GET', url: 'https://example.test' }))).message).toBe('slack.default')
    expect(recorder.requests).toHaveLength(0)
  })
})

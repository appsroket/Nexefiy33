// The action executor with an in-memory database and a fake provider: every
// check happens on the server before a provider is called, approvals bind to
// the exact payload, repeats are deduplicated, retries respect idempotency,
// and every query stays inside the caller's organization. The SQL side
// (queue claims, pending-input rules) is covered by pgTAP 007.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { actionFingerprint, processApprovedExecutions, requestAction, runExecution, type ExecuteRequest } from '@/modules/integrations/server/executor'

import { FakeSupabase } from '../helpers/fake-supabase'
import {
  allowRateLimits,
  fakeToken,
  HUBSPOT_ID,
  HUBSPOT_SCOPES,
  jsonResponse,
  ORG,
  OTHER_ORG,
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

const SEARCH_URL = 'https://api.hubapi.com/crm/objects/2026-09/contacts/search'
const POST_URL = 'https://slack.com/api/chat.postMessage'

function setup(routes: [string, Responder | Responder[]][] = []) {
  const recorder = recordingFetch(routes)
  const { runtime, sleeps } = testRuntime(db, recorder.fetch)
  return { runtime, sleeps, requests: recorder.requests }
}

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    organizationId: ORG,
    integrationId: HUBSPOT_ID,
    actionKey: 'hubspot.contacts.search',
    input: { email: 'dana@example.com' },
    idempotencyKey: `key-${Math.random()}`,
    actor: { kind: 'user', userId: USER, role: 'operator' },
    ...overrides,
  }
}

const slackPost = (overrides: Partial<ExecuteRequest> = {}) =>
  request({ integrationId: SLACK_ID, actionKey: 'slack.messages.post', input: { channel: 'C0123456789', text: 'New lead: Dana' }, ...overrides })

const searchOk: Responder = () => jsonResponse(200, { total: 1, results: [{ id: '501', properties: { email: 'dana@example.com' } }] })
const postOk: Responder = () => jsonResponse(200, { ok: true, channel: 'C0123456789', ts: '1712345678.000100' })

function execution(id?: string) {
  const rows = db.tables.tool_executions ?? []
  return id ? rows.find((row) => row.id === id)! : rows[rows.length - 1]!
}

function allowAction(integrationId: string, actionKey: string) {
  ;(db.tables.integration_actions ??= []).push({ organization_id: ORG, integration_id: integrationId, action_key: actionKey, enabled: true, approval_mode: 'allow' })
}

describe('checks before anything runs', () => {
  it('refuses unknown actions and viewers without recording anything', async () => {
    const { runtime, requests } = setup()
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    expect(await requestAction(runtime, request({ actionKey: 'gmail.send' }))).toMatchObject({ status: 'refused', error: { code: 'invalid_input' } })
    expect(await requestAction(runtime, request({ actor: { kind: 'user', userId: USER, role: 'viewer' } }))).toMatchObject({ status: 'refused', error: { code: 'forbidden' } })
    expect(db.tables.tool_executions).toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  it('validates input on the server and reports each problem', async () => {
    const { runtime, requests } = setup()
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    const result = await requestAction(runtime, request({ actionKey: 'hubspot.contacts.upsert', input: { email: 'nope', lifecycleStage: 'boss' } }))
    expect(result.status).toBe('invalid_input')
    expect(result.status === 'invalid_input' && result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['email', 'lifecycleStage']))
    expect(db.tables.tool_executions).toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  it('never uses another organization’s connection, and scopes every query to the caller’s organization', async () => {
    const { runtime, requests } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES, organizationId: OTHER_ORG })
    expect(await requestAction(runtime, request())).toMatchObject({ status: 'refused', error: { code: 'not_connected' } })
    expect(requests).toHaveLength(0)
    for (const query of db.queries.filter((query) => query.operation !== 'insert' && query.operation !== 'upsert')) {
      expect(query.filters, `${query.table} ${query.operation}`).toContainEqual(['organization_id', 'eq', ORG])
    }
  })

  it('refuses a connection of another provider, a disconnected one, and missing scopes', async () => {
    const { runtime } = setup()
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    expect(await requestAction(runtime, request({ integrationId: SLACK_ID }))).toMatchObject({ error: { code: 'not_connected' } })

    db.tables.integrations = []
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES, status: 'revoked' })
    expect(await requestAction(runtime, request())).toMatchObject({ error: { code: 'not_connected' } })

    db.tables.integrations = []
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: ['oauth'] })
    expect(await requestAction(runtime, request())).toMatchObject({ error: { code: 'insufficient_scope', message: expect.stringContaining('crm.objects.contacts.read') } })
  })
})

describe('credential-shaped input', () => {
  it('refuses input the database flags as containing a credential, without calling the provider', async () => {
    const { runtime, requests } = setup([[POST_URL, postOk]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    db.errorFor = (table, operation) => (table === 'tool_executions' && operation === 'insert' ? { code: '23514' } : null)
    expect(await requestAction(runtime, slackPost())).toMatchObject({ status: 'refused', error: { code: 'invalid_input', message: expect.stringContaining('token') } })
    expect(db.tables.tasks![0]!.status).toBe('cancelled')
    expect(requests).toHaveLength(0)
  })
})

describe('allowed actions', () => {
  it('runs a read action, stores a redacted result, and completes the task', async () => {
    const { runtime, requests } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    const result = await requestAction(runtime, request())
    expect(result).toMatchObject({ status: 'succeeded', output: { total: 1, contacts: [expect.objectContaining({ id: '501' })] } })
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${fakeToken('access')}`)
    expect(execution()).toMatchObject({
      status: 'succeeded',
      policy_decision: 'allow',
      output_redacted: { total: 1, contactIds: ['501'] },
      pending_input: null,
      requested_by: USER,
      input_sha256: actionFingerprint('hubspot.contacts.search', HUBSPOT_ID, { email: 'dana@example.com', limit: 5 }),
    })
    expect(db.tables.tasks![0]).toMatchObject({ status: 'succeeded', source: 'manual', created_by: USER })
    expect(db.tables.execution_events!.map((event) => event.event_type)).toContain('tool.succeeded')
  })

  it('returns the first result for a repeated idempotency key without calling the provider again', async () => {
    const { runtime, requests } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    const first = await requestAction(runtime, request({ idempotencyKey: 'same' }))
    const second = await requestAction(runtime, request({ idempotencyKey: 'same' }))
    expect(first.status).toBe('succeeded')
    expect(second).toMatchObject({ status: 'duplicate', executionStatus: 'succeeded' })
    expect(requests).toHaveLength(1)
  })
})

describe('approvals', () => {
  it('holds an external write for approval with the exact payload, without calling the provider', async () => {
    const { runtime, requests } = setup()
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    const result = await requestAction(runtime, slackPost())
    expect(result.status).toBe('awaiting_approval')
    expect(requests).toHaveLength(0)

    const pending = execution()
    const approval = db.tables.approval_requests![0]!
    expect(pending).toMatchObject({ status: 'awaiting_approval', policy_decision: 'require_approval', pending_input: { channel: 'C0123456789', text: 'New lead: Dana' } })
    expect(pending.input_redacted).toEqual({ channel: 'C0123456789', textPreview: 'New lead: Dana', textLength: 14 })
    expect(approval).toMatchObject({
      organization_id: ORG,
      tool_execution_id: pending.id,
      payload_sha256: pending.input_sha256,
      required_role: 'admin',
      proposed_action: { action: 'slack.messages.post', input: { channel: 'C0123456789', text: 'New lead: Dana' } },
    })
    expect(Date.parse(approval.expires_at as string) - Date.parse('2026-10-18T12:00:00Z')).toBe(72 * 3_600_000)
    expect(db.tables.tasks![0]!.status).toBe('waiting_approval')
  })

  it('runs an approved action from the queue, re-checking the connection first', async () => {
    const { runtime, requests } = setup([[POST_URL, postOk]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    await requestAction(runtime, slackPost())
    const pending = execution()
    // What decide_approval + claim_tool_executions do in SQL (pgTAP 007).
    Object.assign(pending, { status: 'executing', lease_expires_at: '2026-10-18T12:02:00Z' })
    db.rpcHandlers.claim_tool_executions = () => ({ data: [{ tool_execution_id: pending.id, organization_id: ORG, attempt: 1, recovered: false }], error: null })

    const run = await processApprovedExecutions(runtime)
    expect(run.results[0]).toMatchObject({ status: 'succeeded', output: { ts: '1712345678.000100' } })
    expect(requests[0]!.json()).toMatchObject({ channel: 'C0123456789', text: 'New lead: Dana' })
    expect(execution(pending.id as string)).toMatchObject({ status: 'succeeded', pending_input: null })
    expect(db.tables.tasks![0]!.status).toBe('succeeded')
  })

  it('refuses to run an approved action whose stored input no longer matches the approved fingerprint', async () => {
    const { runtime, requests } = setup([[POST_URL, postOk]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    await requestAction(runtime, slackPost())
    const pending = execution()
    Object.assign(pending, { status: 'executing', pending_input: { channel: 'C0123456789', text: 'Something else' } })
    const result = await runExecution(runtime, { executionId: pending.id as string, organizationId: ORG, attempt: 1, recovered: false })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } })
    expect(requests).toHaveLength(0)
  })

  it('does not run an approved action after the connection was disconnected', async () => {
    const { runtime, requests } = setup([[POST_URL, postOk]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    await requestAction(runtime, slackPost())
    const pending = execution()
    Object.assign(pending, { status: 'executing' })
    db.tables.integrations![0]!.status = 'revoked'
    const result = await runExecution(runtime, { executionId: pending.id as string, organizationId: ORG, attempt: 1, recovered: false })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'not_connected' } })
    expect(requests).toHaveLength(0)
  })

  it('runs immediately when an admin allows the action, and blocks it when turned off or denied by policy', async () => {
    const { runtime, requests } = setup([[POST_URL, postOk]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    allowAction(SLACK_ID, 'slack.messages.post')
    expect((await requestAction(runtime, slackPost())).status).toBe('succeeded')

    db.tables.organization_policies = [
      { id: 'p1', organization_id: ORG, name: 'No Slack', enabled: true, priority: 1, policy: { rules: [{ effect: 'deny', toolKeys: ['slack.*'] }] } },
    ]
    const denied = await requestAction(runtime, slackPost())
    expect(denied).toMatchObject({ status: 'denied', reason: expect.stringContaining('No Slack') })
    expect(execution()).toMatchObject({ status: 'skipped', policy_decision: 'deny', policy_id: 'p1', pending_input: null })

    db.tables.organization_policies = []
    db.tables.integration_actions![0]!.enabled = false
    expect((await requestAction(runtime, slackPost())).status).toBe('denied')
    expect(requests).toHaveLength(1)
  })

  it('applies a policy that requires approval even when the connection allows the action', async () => {
    const { runtime } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    db.tables.organization_policies = [
      { id: 'p2', organization_id: ORG, name: 'Review CRM', enabled: true, priority: 1, policy: { rules: [{ effect: 'require_approval', toolKeys: ['hubspot.*'] }], defaults: { approvalExpiresInHours: 4 } } },
    ]
    expect((await requestAction(runtime, request())).status).toBe('awaiting_approval')
    expect(db.tables.approval_requests![0]).toMatchObject({ policy_id: 'p2', required_role: 'operator' })
    expect(Date.parse(db.tables.approval_requests![0]!.expires_at as string) - Date.parse('2026-10-18T12:00:00Z')).toBe(4 * 3_600_000)
  })
})

describe('failures and retries', () => {
  it('retries a read after a temporary failure', async () => {
    const { runtime, requests, sleeps } = setup([[SEARCH_URL, [() => jsonResponse(503, 'busy'), searchOk]]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    expect((await requestAction(runtime, request())).status).toBe('succeeded')
    expect(requests).toHaveLength(2)
    expect(sleeps).toEqual([500])
    expect(execution().status).toBe('succeeded')
  })

  it('never resends a Slack message after a server error, but does after a 429 refusal', async () => {
    const failing = setup([[POST_URL, () => jsonResponse(500, 'oops')]])
    await seedConnection(db, failing.runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    allowAction(SLACK_ID, 'slack.messages.post')
    expect(await requestAction(failing.runtime, slackPost())).toMatchObject({ status: 'failed', error: { code: 'unavailable' } })
    expect(failing.requests).toHaveLength(1)

    const limited = setup([[POST_URL, [() => jsonResponse(429, '', { 'retry-after': '1' }), postOk]]])
    expect((await requestAction(limited.runtime, slackPost())).status).toBe('succeeded')
    expect(limited.requests).toHaveLength(2)
    expect(limited.sleeps).toEqual([1000])
  })

  it('reports an unknown outcome when a non-idempotent action times out', async () => {
    const { runtime } = setup()
    runtime.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'))
        if (init.signal?.aborted) abort()
        else init.signal?.addEventListener('abort', abort)
      })
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    allowAction(SLACK_ID, 'slack.messages.post')
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort())
    try {
      expect(await requestAction(runtime, slackPost())).toMatchObject({ status: 'failed', error: { code: 'outcome_unknown' } })
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('does not resend a non-idempotent action recovered from a lost lease', async () => {
    const { runtime, requests } = setup([[POST_URL, postOk]])
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    await requestAction(runtime, slackPost())
    const pending = execution()
    Object.assign(pending, { status: 'executing' })
    const result = await runExecution(runtime, { executionId: pending.id as string, organizationId: ORG, attempt: 2, recovered: true })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'outcome_unknown' } })
    expect(requests).toHaveLength(0)
  })

  it('stops before the provider when the shared rate-limit window is full', async () => {
    const { runtime, requests } = setup([[SEARCH_URL, searchOk]])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES })
    db.rpcHandlers.consume_integration_rate_limit = () => ({ data: [{ allowed: false, retry_after_ms: 60_000 }], error: null })
    expect(await requestAction(runtime, request())).toMatchObject({ status: 'failed', error: { code: 'rate_limited', providerCode: 'local_limit' } })
    expect(requests).toHaveLength(0)
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_organization_id: ORG, p_integration_id: HUBSPOT_ID, p_bucket: 'hubspot.search', p_limit: 4, p_window_seconds: 1 })
  })

  it('renews a rejected token once, then marks the connection for reconnection if that fails too', async () => {
    const { runtime, requests } = setup([
      [SEARCH_URL, () => jsonResponse(401, { status: 'error', category: 'EXPIRED_AUTHENTICATION', message: 'The OAuth token used to make this call expired.' })],
      ['https://api.hubapi.com/oauth/2026-03/token', () => jsonResponse(400, { error: 'invalid_grant', message: 'refresh token revoked' })],
    ])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES, tokens: { accessToken: fakeToken('old'), refreshToken: fakeToken('refresh'), expiresAt: '2026-10-18T12:20:00Z', scopes: HUBSPOT_SCOPES } })
    const result = await requestAction(runtime, request())
    expect(result).toMatchObject({ status: 'failed', error: { code: 'reauth_required' } })
    expect(requests.map((item) => item.url)).toEqual([SEARCH_URL, 'https://api.hubapi.com/oauth/2026-03/token'])
    expect(db.tables.integrations![0]).toMatchObject({ status: 'needs_reauth', health_status: 'unhealthy' })
  })

  it('succeeds after a forced renewal when the provider rejected a stale token', async () => {
    const { runtime, requests } = setup([
      [SEARCH_URL, [() => jsonResponse(401, { status: 'error', category: 'EXPIRED_AUTHENTICATION' }), searchOk]],
      ['https://api.hubapi.com/oauth/2026-03/token', () => jsonResponse(200, { access_token: fakeToken('fresh'), expires_in: 1800 })],
    ])
    await seedConnection(db, runtime, { provider: 'hubspot', scopes: HUBSPOT_SCOPES, tokens: { accessToken: fakeToken('old'), refreshToken: fakeToken('refresh'), expiresAt: '2026-10-18T12:20:00Z', scopes: HUBSPOT_SCOPES } })
    expect((await requestAction(runtime, request())).status).toBe('succeeded')
    expect(requests[2]!.headers.authorization).toBe(`Bearer ${fakeToken('fresh')}`)
  })
})

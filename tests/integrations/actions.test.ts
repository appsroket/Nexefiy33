// Integration Server Actions and the OAuth callback route with the session,
// runtime and Next.js replaced by fakes: roles are checked before anything
// privileged happens, ids from the browser are validated, and the console
// passes only the verified member's organization and role to the executor.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrganizationRole } from '@/lib/supabase/types'

import { FakeSupabase } from '../helpers/fake-supabase'
import { allowRateLimits, jsonResponse, ORG, recordingFetch, seedConnection, SLACK_ID, SLACK_SCOPES, testRuntime, USER } from '../helpers/integration-fixtures'

let db: FakeSupabase
let role: OrganizationRole | null = 'admin'
let signedIn = true
let configured = true
let fetchRecorder = recordingFetch([])

const redirect = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { url })
})

vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/modules/integrations/server/membership', () => ({
  getVerifiedMember: async () =>
    !signedIn ? { status: 'signed_out' } : role ? { status: 'ok', user: { id: USER, email: null }, role } : { status: 'not_member' },
}))
vi.mock('@/lib/supabase/server', () => ({
  createUserClient: async () =>
    Object.assign(db, { auth: { getUser: async () => (signedIn ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: {} }) } }),
}))
vi.mock('@/modules/integrations/server/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/integrations/server/runtime')>()),
  getIntegrationRuntime: () => testRuntime(db, fetchRecorder.fetch).runtime,
  isConnectorConfigured: () => configured,
}))

const actions = await import('@/modules/integrations/server/actions')
const callback = await import('@/app/api/integrations/[provider]/callback/route')

beforeEach(() => {
  db = new FakeSupabase()
  db.uniqueKeys.tasks = [['organization_id', 'idempotency_key']]
  db.uniqueKeys.tool_executions = [['organization_id', 'idempotency_key']]
  allowRateLimits(db)
  role = 'admin'
  signedIn = true
  configured = true
  fetchRecorder = recordingFetch([])
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

describe('startConnection', () => {
  it('lets only admins start a connection, and only for known, configured providers', async () => {
    role = 'operator'
    expect(await actions.startConnection(ORG, 'slack')).toMatchObject({ status: 'error', message: expect.stringContaining('admins') })
    role = 'admin'
    expect(await actions.startConnection(ORG, 'gmail')).toMatchObject({ status: 'error' })
    expect(await actions.startConnection('not-a-uuid', 'slack')).toMatchObject({ status: 'error' })
    configured = false
    expect(await actions.startConnection(ORG, 'slack')).toMatchObject({ message: expect.stringContaining('isn’t set up') })
    expect(db.tables.integration_oauth_states).toBeUndefined()
  })

  it('redirects an admin to the provider', async () => {
    await expect(actions.startConnection(ORG, 'slack')).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect.mock.calls[0]![0]).toMatch(/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/)
    expect(db.tables.integration_oauth_states).toHaveLength(1)
  })
})

describe('runIntegrationAction', () => {
  const run = (values: Record<string, string>) =>
    actions.runIntegrationAction(
      { status: 'idle' },
      form({ organizationId: ORG, integrationId: SLACK_ID, idempotencyKey: '33333333-3333-4333-8333-333333333333', actionKey: 'slack.channels.list', input: '{}', ...values }),
    )

  it('refuses signed-out users, non-members and viewers', async () => {
    signedIn = false
    expect(await run({})).toMatchObject({ status: 'error' })
    signedIn = true
    role = null
    expect(await run({})).toMatchObject({ status: 'error' })
    role = 'viewer'
    expect(await run({})).toMatchObject({ status: 'error' })
    expect(db.tables.tool_executions).toBeUndefined()
  })

  it('rejects malformed ids and input before doing anything', async () => {
    expect(await run({ integrationId: 'x' })).toMatchObject({ status: 'error' })
    expect(await run({ input: '{nope' })).toMatchObject({ message: 'The input isn’t valid JSON.' })
    expect(await run({ input: 'x'.repeat(20_001) })).toMatchObject({ status: 'error' })
    expect(db.queries).toEqual([])
  })

  it('runs an allowed action for an operator and reports a held write for approval', async () => {
    role = 'operator'
    const runtime = testRuntime(db, fetchRecorder.fetch).runtime
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    fetchRecorder = recordingFetch([['https://slack.com/api/conversations.list', () => jsonResponse(200, { ok: true, channels: [] })]])
    expect(await run({})).toMatchObject({ status: 'done', outcome: 'succeeded', output: { channels: [] } })
    expect(db.tables.tool_executions![0]).toMatchObject({ organization_id: ORG, requested_by: USER, idempotency_key: 'console:33333333-3333-4333-8333-333333333333' })

    const held = await run({
      actionKey: 'slack.messages.post',
      input: JSON.stringify({ channel: 'C0123456789', text: 'Hello' }),
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    })
    expect(held).toMatchObject({ status: 'done', outcome: 'awaiting_approval' })
  })

  it('shows validation problems from the action schema', async () => {
    const runtime = testRuntime(db, fetchRecorder.fetch).runtime
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    const result = await run({ actionKey: 'slack.messages.post', input: JSON.stringify({ channel: '#general' }) })
    expect(result).toMatchObject({ status: 'error', issues: expect.arrayContaining([expect.objectContaining({ path: 'channel' }), expect.objectContaining({ path: 'text' })]) })
  })
})

describe('updateActionSetting', () => {
  const save = (values: Record<string, string>) =>
    actions.updateActionSetting(
      { status: 'idle' },
      form({ organizationId: ORG, integrationId: SLACK_ID, actionKey: 'slack.messages.post', enabled: 'on', approvalMode: 'require_approval', ...values }),
    )

  it('lets only admins change settings, for actions of the connection’s provider', async () => {
    role = 'operator'
    expect(await save({})).toMatchObject({ status: 'error', message: expect.stringContaining('admins') })
    role = 'admin'
    db.tables.integrations = [{ id: SLACK_ID, organization_id: ORG, provider: 'slack' }]
    expect(await save({ actionKey: 'hubspot.contacts.search' })).toMatchObject({ status: 'error' })
    expect(await save({ approvalMode: 'sometimes' })).toMatchObject({ status: 'error' })
    // Sending a message is consequential: only a workspace policy can let it run without approval.
    expect(await save({ approvalMode: 'allow' })).toMatchObject({ status: 'error', message: expect.stringContaining('workspace policy') })
  })

  it('saves the setting scoped to the workspace and connection', async () => {
    db.tables.integrations = [{ id: SLACK_ID, organization_id: ORG, provider: 'slack' }]
    db.tables.integration_actions = [{ organization_id: ORG, integration_id: SLACK_ID, action_key: 'slack.messages.post', enabled: true, approval_mode: 'require_approval' }]
    expect(await save({ approvalMode: 'deny' })).toMatchObject({ status: 'success' })
    expect(db.tables.integration_actions[0]).toMatchObject({ approval_mode: 'deny', enabled: true })
    expect(db.queries.at(-1)!.filters).toEqual([
      ['integration_id', 'eq', SLACK_ID],
      ['organization_id', 'eq', ORG],
      ['action_key', 'eq', 'slack.messages.post'],
    ])
  })
})

describe('disconnectIntegration', () => {
  it('lets only admins disconnect', async () => {
    role = 'operator'
    expect(await actions.disconnectIntegration(ORG, SLACK_ID)).toMatchObject({ status: 'error', message: expect.stringContaining('admins') })
  })

  it('reports what happened at the provider', async () => {
    const runtime = testRuntime(db, fetchRecorder.fetch).runtime
    await seedConnection(db, runtime, { provider: 'slack', scopes: SLACK_SCOPES })
    fetchRecorder = recordingFetch([['https://slack.com/api/auth.revoke', () => jsonResponse(200, { ok: true, revoked: true })]])
    expect(await actions.disconnectIntegration(ORG, SLACK_ID)).toMatchObject({ status: 'success', message: expect.stringContaining('revoked at the provider') })
  })
})

describe('OAuth callback route', () => {
  const call = (query: string) =>
    callback.GET(Object.assign(new Request(`https://app.example.test/api/integrations/slack/callback?${query}`), { nextUrl: new URL(`https://app.example.test/api/integrations/slack/callback?${query}`) }) as never, {
      params: Promise.resolve({ provider: 'slack' }),
    })

  it('returns to Integrations with a reason when the person declined or the request is incomplete', async () => {
    expect((await call('error=access_denied&state=x')).headers.get('location')).toContain('connect_error=denied')
    expect((await call('state=x')).headers.get('location')).toContain('connect_error=invalid_request')
  })

  it('rejects an unknown state and a user who is no longer an admin', async () => {
    expect((await call('code=c&state=unknown')).headers.get('location')).toContain('connect_error=invalid_state')

    await expect(actions.startConnection(ORG, 'slack')).rejects.toThrow('NEXT_REDIRECT')
    const state = new URL(redirect.mock.calls[0]![0] as string).searchParams.get('state')!
    role = 'operator'
    expect((await call(`code=c&state=${encodeURIComponent(state)}`)).headers.get('location')).toContain('connect_error=not_allowed')
    expect(db.tables.integrations ?? []).toHaveLength(0)
  })

  it('completes the connection and opens its page', async () => {
    await expect(actions.startConnection(ORG, 'slack')).rejects.toThrow('NEXT_REDIRECT')
    const state = new URL(redirect.mock.calls[0]![0] as string).searchParams.get('state')!
    fetchRecorder = recordingFetch([
      ['https://slack.com/api/oauth.v2.access', () => jsonResponse(200, { ok: true, access_token: 'test-bot-ffff', scope: 'channels:read,chat:write', team: { id: 'T0001', name: 'Example' } })],
    ])
    const response = await call(`code=c&state=${encodeURIComponent(state)}`)
    const id = db.tables.integrations![0]!.id
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`https://app.example.test/app/integrations/${id}?connected=slack`)
  })
})

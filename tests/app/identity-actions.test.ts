// Server Actions for auth, workspaces and members, with Supabase, Next.js and
// configuration replaced by fakes. Authorization itself is enforced by the
// database (supabase/tests/database/003 and 005); these tests check that the
// actions validate input before calling Supabase, verify the session, translate
// refusals, never redirect off-site, and never log secrets.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActionState } from '@/lib/forms/action-state'

const TOKEN = 'cd'.repeat(32)
const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'
const ME = '33333333-3333-4333-8333-333333333333'

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`)
  }
}

interface QueryResult {
  data: unknown
  error: { code?: string; message?: string } | null
  count?: number
}

/** A chainable stand-in for a PostgREST query that resolves to `result`. */
function query(result: QueryResult) {
  const calls: { method: string; args: unknown[] }[] = []
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit']) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    }
  }
  chain.maybeSingle = async () => result
  chain.then = (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return { chain, calls }
}

const state = {
  ip: '203.0.113.1',
  cookies: new Map<string, string>(),
  email: undefined as undefined | { resendApiKey: string; from: string },
  user: { id: ME, email: 'me@example.com' } as { id: string; email: string } | null,
  /** A result per table, or a list consumed one query at a time. */
  tables: {} as Record<string, QueryResult | QueryResult[]>,
  queries: [] as { table: string; calls: { method: string; args: unknown[] }[] }[],
}

const auth = {
  getUser: vi.fn(async () => (state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { code: 'session_not_found' } })),
  signInWithPassword: vi.fn(async (_credentials: { email: string; password: string }) => ({ data: {}, error: null as null | { code: string; status: number } })),
  signUp: vi.fn(async (_input: unknown) => ({ data: { session: null }, error: null as null | { code: string; status: number } })),
  resetPasswordForEmail: vi.fn(async (_email: string, _options: unknown) => ({ data: {}, error: null as null | { code: string; status: number } })),
  updateUser: vi.fn(async (_attributes: unknown) => ({ data: {}, error: null as null | { code: string; status: number } })),
  signOut: vi.fn(async (_options: unknown) => ({ error: null })),
  resend: vi.fn(async (_input: unknown) => ({ data: {}, error: null })),
  exchangeCodeForSession: vi.fn(async (_code: string) => ({ data: {}, error: null as null | { code: string; status: number } })),
  verifyOtp: vi.fn(async (_input: unknown) => ({ data: {}, error: null as null | { code: string; status: number } })),
}
const rpc = vi.fn(async (_name: string, _args: unknown): Promise<QueryResult> => ({ data: null, error: null }))

vi.mock('@/lib/supabase/server', () => ({
  createUserClient: async () => ({
    auth,
    rpc,
    from: (table: string) => {
      const entry = state.tables[table]
      const result = Array.isArray(entry) ? (entry.shift() ?? { data: [], error: null }) : (entry ?? { data: [], error: null })
      const { chain, calls } = query(result)
      state.queries.push({ table, calls })
      return chain
    },
  }),
}))
vi.mock('@/lib/env/server', () => ({
  getServerEnv: () => ({ appEnv: 'development', core: { appUrl: 'http://localhost:3000' }, email: state.email }),
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': state.ip }),
  cookies: async () => ({
    set: (name: string, value: string) => state.cookies.set(name, value),
    delete: (name: string) => state.cookies.delete(name),
    get: (name: string) => (state.cookies.has(name) ? { value: state.cookies.get(name) } : undefined),
  }),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url)
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { changePassword, requestPasswordReset, signIn, signUp } = await import('@/modules/identity/server/auth-actions')
const { changeMemberRole, inviteMember, removeMember } = await import('@/modules/identity/server/member-actions')
const { acceptInvitation, lookupInvitation } = await import('@/modules/identity/server/invitation-actions')
const { createWorkspace, deleteWorkspace } = await import('@/modules/identity/server/workspace-actions')
const callbackRoute = await import('@/app/auth/callback/route')
const confirmRoute = await import('@/app/auth/confirm/route')

const IDLE: ActionState = { status: 'idle' }

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  if (!(error instanceof Redirect)) throw new Error(`expected a redirect, got ${String(error)}`)
  return error.url
}

let ipCounter = 0
let logged: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ipCounter += 1
  state.ip = `203.0.113.${ipCounter}`
  state.cookies.clear()
  state.email = undefined
  state.user = { id: ME, email: 'me@example.com' }
  state.tables = {}
  state.queries = []
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllMocks()
  logged.mockRestore()
})

describe('sign-in', () => {
  it('validates before calling Supabase', async () => {
    const result = await signIn(IDLE, form({ email: 'not-an-email', password: '' }))
    expect(result.status === 'error' && Object.keys(result.fieldErrors ?? {})).toEqual(['email', 'password'])
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
  })

  it('redirects to a safe next path only', async () => {
    expect(await redirectOf(signIn(IDLE, form({ email: 'me@example.com', password: 'pw', next: '/app/settings' })))).toBe('/app/settings')
    expect(await redirectOf(signIn(IDLE, form({ email: 'me@example.com', password: 'pw', next: 'https://evil.example' })))).toBe('/app')
  })

  it('reports wrong credentials without logging the email or password', async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: 'invalid_credentials', status: 400 } })
    const result = await signIn(IDLE, form({ email: 'me@example.com', password: 'hunter2-secret' }))
    expect(result).toMatchObject({ status: 'error', code: 'invalid_credentials' })
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/me@example\.com|hunter2/)
  })

  it('flags unconfirmed email so the form can offer to resend', async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: 'email_not_confirmed', status: 400 } })
    expect(await signIn(IDLE, form({ email: 'me@example.com', password: 'pw' }))).toMatchObject({ code: 'email_not_confirmed' })
  })

  it('rate-limits repeated attempts from one address', async () => {
    const results = []
    for (let attempt = 0; attempt < 11; attempt += 1) {
      // The 11th attempt never reaches Supabase, so only 10 responses are queued.
      if (attempt < 10) auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: 'invalid_credentials', status: 400 } })
      results.push(await signIn(IDLE, form({ email: 'me@example.com', password: 'pw' })))
    }
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(10)
    expect(results.at(-1)).toMatchObject({ status: 'error', message: expect.stringMatching(/Too many attempts/) })
  })
})

describe('sign-up and password reset', () => {
  it('asks Supabase to email a confirmation link back to this app, then says to check email', async () => {
    const result = await signUp(IDLE, form({ fullName: 'Sam', email: 'Sam@Example.com', password: 'a long password', next: '/invite' }))
    expect(result).toMatchObject({ status: 'success', data: { email: 'sam@example.com' } })
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'sam@example.com',
      password: 'a long password',
      options: { emailRedirectTo: 'http://localhost:3000/auth/callback?next=%2Finvite', data: { full_name: 'Sam' } },
    })
  })

  it('shows a weak password as a field error', async () => {
    auth.signUp.mockResolvedValueOnce({ data: { session: null }, error: { code: 'weak_password', status: 422 } })
    const result = await signUp(IDLE, form({ fullName: 'Sam', email: 'sam@example.com', password: 'password123' }))
    expect(result.status === 'error' && result.fieldErrors?.password).toBeTruthy()
  })

  it('answers the same way whether or not the account exists, and links back to the reset page', async () => {
    const result = await requestPasswordReset(IDLE, form({ email: 'nobody@example.com' }))
    expect(result.status).toBe('success')
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('nobody@example.com', {
      redirectTo: 'http://localhost:3000/auth/callback?next=%2Freset-password',
    })
  })

  it('requires the current password before changing it, then signs out other sessions', async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: 'invalid_credentials', status: 400 } })
    const wrong = await changePassword(IDLE, form({ currentPassword: 'nope', password: 'a new password', confirmPassword: 'a new password' }))
    expect(wrong.status === 'error' && wrong.fieldErrors?.currentPassword).toBeTruthy()
    expect(auth.updateUser).not.toHaveBeenCalled()

    const ok = await changePassword(IDLE, form({ currentPassword: 'old', password: 'a new password', confirmPassword: 'a new password' }))
    expect(ok.status).toBe('success')
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'a new password' })
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'others' })
  })
})

describe('workspaces', () => {
  it('refuses when the session was ended elsewhere', async () => {
    state.user = null
    const result = await createWorkspace(IDLE, form({ name: 'Acme', slug: 'acme' }))
    expect(result).toMatchObject({ status: 'error', code: 'session_ended' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('shows a taken address as a field error', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key' } })
    const result = await createWorkspace(IDLE, form({ name: 'Acme', slug: 'acme' }))
    expect(result.status === 'error' && result.fieldErrors?.slug).toEqual(['That address is already taken. Try another one.'])
  })

  it('makes a new workspace the active one', async () => {
    rpc.mockResolvedValueOnce({ data: { id: ORG }, error: null })
    expect(await redirectOf(createWorkspace(IDLE, form({ name: 'Acme', slug: 'acme' })))).toBe('/app')
    expect(rpc).toHaveBeenCalledWith('create_organization', { p_name: 'Acme', p_slug: 'acme' })
    expect(state.cookies.get('nxf_workspace')).toBe(ORG)
  })

  it('deletes only after the address is typed, and treats zero deleted rows as not allowed', async () => {
    state.tables.organizations = { data: { slug: 'acme' }, error: null }
    const wrong = await deleteWorkspace(IDLE, form({ organizationId: ORG, confirmation: 'acm' }))
    expect(wrong.status === 'error' && wrong.fieldErrors?.confirmation).toBeTruthy()
    expect(state.queries.some((q) => q.calls.some((call) => call.method === 'delete'))).toBe(false)

    // An admin can read the workspace, but RLS lets only owners delete it: zero rows come back.
    state.tables.organizations = [
      { data: { slug: 'acme' }, error: null },
      { data: [], error: null },
    ]
    const refused = await deleteWorkspace(IDLE, form({ organizationId: ORG, confirmation: 'acme' }))
    expect(refused).toMatchObject({ status: 'error', message: 'Only an owner can delete this workspace.' })
    expect(state.cookies.size).toBe(0)

    state.cookies.set('nxf_workspace', ORG)
    state.tables.organizations = [
      { data: { slug: 'acme' }, error: null },
      { data: [{ id: ORG }], error: null },
    ]
    expect(await redirectOf(deleteWorkspace(IDLE, form({ organizationId: ORG, confirmation: 'acme' })))).toBe('/app')
    expect(state.cookies.has('nxf_workspace')).toBe(false)
  })

  it('rejects a malformed workspace id before touching the database', async () => {
    const result = await deleteWorkspace(IDLE, form({ organizationId: 'not-a-uuid', confirmation: 'acme' }))
    expect(result.status).toBe('error')
    expect(state.queries).toHaveLength(0)
  })
})

describe('members', () => {
  it('rejects unknown roles and malformed ids before touching the database', async () => {
    expect((await changeMemberRole(ORG, OTHER_USER, 'superuser')).status).toBe('error')
    expect((await changeMemberRole('x', OTHER_USER, 'viewer')).status).toBe('error')
    expect(state.queries).toHaveLength(0)
  })

  it('treats a change that touched no rows as not allowed (RLS filtered it out)', async () => {
    state.tables.organization_members = { data: [], error: null }
    expect(await changeMemberRole(ORG, OTHER_USER, 'admin')).toMatchObject({ status: 'error', message: expect.stringMatching(/permission/) })
  })

  it('explains database refusals in plain language', async () => {
    state.tables.organization_members = { data: null, error: { code: '23514', message: 'an organization must keep at least one owner' } }
    expect(await changeMemberRole(ORG, OTHER_USER, 'viewer')).toMatchObject({ message: expect.stringMatching(/always have an owner/) })
    state.tables.organization_members = { data: null, error: { code: '42501', message: 'admins can only manage operators and viewers' } }
    expect(await removeMember(ORG, OTHER_USER)).toMatchObject({ message: 'Admins can only manage operators and viewers.' })
  })

  it('removes by revoking the membership, and never removes yourself', async () => {
    expect(await removeMember(ORG, ME)).toMatchObject({ status: 'error', message: expect.stringMatching(/Leave workspace/) })
    state.tables.organization_members = { data: [{ user_id: OTHER_USER }], error: null }
    expect((await removeMember(ORG, OTHER_USER)).status).toBe('success')
    const update = state.queries.at(-1)!.calls.find((call) => call.method === 'update')
    expect(update?.args).toEqual([{ status: 'revoked' }])
  })
})

describe('invitations', () => {
  it('returns a link to share when email isn’t configured, and never logs the token', async () => {
    rpc.mockResolvedValueOnce({ data: [{ invitation_id: 'i', token: TOKEN, expires_at: '2026-10-25T00:00:00Z' }], error: null })
    state.tables.organizations = { data: { name: 'Acme' }, error: null }
    state.tables.profiles = { data: { full_name: 'Me', email: 'me@example.com' }, error: null }
    const result = await inviteMember(IDLE, form({ organizationId: ORG, email: 'New@Example.com', role: 'operator' }))
    expect(result).toMatchObject({ status: 'success', data: { link: `http://localhost:3000/invite#${TOKEN}`, email: 'new@example.com' } })
    expect(rpc).toHaveBeenCalledWith('create_invitation', { p_organization_id: ORG, p_email: 'new@example.com', p_role: 'operator' })
    expect(JSON.stringify(logged.mock.calls)).not.toContain(TOKEN)
  })

  it('emails the invitation when email is configured, without returning the link', async () => {
    state.email = { resendApiKey: 're_test', from: 'Nexefiy <team@mail.example.com>' }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    rpc.mockResolvedValueOnce({ data: [{ invitation_id: 'i', token: TOKEN, expires_at: '2026-10-25T00:00:00Z' }], error: null })
    const result = await inviteMember(IDLE, form({ organizationId: ORG, email: 'new@example.com', role: 'viewer' }))
    expect(result).toEqual({ status: 'success', message: 'Invitation sent to new@example.com.' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockRestore()
  })

  it('explains duplicates and missing permission', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'this person is already a member' } })
    const member = await inviteMember(IDLE, form({ organizationId: ORG, email: 'a@example.com', role: 'viewer' }))
    expect(member.status === 'error' && member.fieldErrors?.email).toEqual(['This person is already a member.'])
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not allowed' } })
    expect(await inviteMember(IDLE, form({ organizationId: ORG, email: 'a@example.com', role: 'admin' }))).toMatchObject({
      message: 'Only owners can invite admins.',
    })
  })

  it('never sends a malformed token to the database', async () => {
    expect((await acceptInvitation('../../etc')).status).toBe('error')
    expect(await lookupInvitation('short')).toEqual({ status: 'not_found' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('asks signed-out visitors to sign in, and accepting makes the workspace active', async () => {
    state.user = null
    expect(await lookupInvitation(TOKEN)).toEqual({ status: 'signed_out' })
    expect(await acceptInvitation(TOKEN)).toMatchObject({ code: 'session_ended' })

    state.user = { id: ME, email: 'me@example.com' }
    rpc.mockResolvedValueOnce({ data: ORG, error: null })
    expect((await acceptInvitation(TOKEN)).status).toBe('success')
    expect(state.cookies.get('nxf_workspace')).toBe(ORG)
  })

  it('gives one message for expired, revoked, used and wrong-address invitations', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invitation is invalid or has expired' } })
    expect(await acceptInvitation(TOKEN)).toMatchObject({ status: 'error', message: expect.stringMatching(/can’t be used/) })
    expect(state.cookies.has('nxf_workspace')).toBe(false)
  })
})

describe('email link routes', () => {
  const get = async (route: { GET: (request: never) => Promise<Response> }, path: string) => {
    const response = await route.GET(new Request(`http://localhost:3000${path}`) as never)
    return response.headers.get('location')
  }

  it('exchanges the code and continues to a safe in-app path', async () => {
    expect(await get(callbackRoute, '/auth/callback?code=abc&next=%2Finvite')).toBe('http://localhost:3000/invite')
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('abc')
    expect(await get(callbackRoute, '/auth/callback?code=abc&next=https%3A%2F%2Fevil.example')).toBe('http://localhost:3000/app')
  })

  it('sends failed or missing codes back to sign-in, or to a new reset link, without logging the code', async () => {
    expect(await get(callbackRoute, '/auth/callback')).toBe('http://localhost:3000/sign-in?error=link')
    auth.exchangeCodeForSession.mockResolvedValueOnce({ data: {}, error: { code: 'flow_state_expired', status: 400 } })
    expect(await get(callbackRoute, '/auth/callback?code=secret-code&next=%2Freset-password')).toBe(
      'http://localhost:3000/forgot-password?expired=1',
    )
    expect(JSON.stringify(logged.mock.calls)).not.toContain('secret-code')
  })

  it('verifies token-hash links and always sends recovery links to the new-password page', async () => {
    expect(await get(confirmRoute, '/auth/confirm?token_hash=h&type=recovery&next=%2Fapp')).toBe('http://localhost:3000/reset-password')
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'h' })
    expect(await get(confirmRoute, '/auth/confirm?token_hash=h&type=bogus')).toBe('http://localhost:3000/sign-in?error=link')
  })
})

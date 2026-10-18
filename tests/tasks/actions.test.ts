// Task Server Actions with the session and database replaced by fakes: the
// session is confirmed first, input is validated on the server, the work goes
// through the SQL functions under the user's session (which check role and
// state — pgTAP 009), their errors become plain messages, and the runtime is
// nudged after the response.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeSupabase } from '../helpers/fake-supabase'

const EMPLOYEE = 'a2000000-0000-4000-8000-000000000001'
const TASK = 'a7000000-0000-4000-8000-000000000001'

let db: FakeSupabase
let signedIn = true
const scheduled = vi.fn()
const redirect = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { url })
})

vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createUserClient: async () => db }))
vi.mock('@/modules/identity/server/session', () => ({
  SESSION_ENDED_MESSAGE: 'Your session ended.',
  getVerifiedUser: async () => (signedIn ? { id: 'a0000000-0000-4000-8000-000000000003', email: null } : null),
}))
vi.mock('@/modules/tasks/server/scheduling', () => ({ canRunTasks: () => true, scheduleTaskProcessing: (...args: unknown[]) => scheduled(...args) }))

const actions = await import('@/modules/tasks/server/actions')

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

beforeEach(() => {
  db = new FakeSupabase()
  signedIn = true
  scheduled.mockClear()
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('assigning a task', () => {
  it('assigns through assign_employee_task with a stable request key, nudges the runtime and opens the task', async () => {
    db.rpcHandlers.assign_employee_task = () => ({ data: TASK, error: null })
    await expect(
      actions.assignTask({ status: 'idle' }, form({ employeeId: EMPLOYEE, title: '  Find Dana  ', instructions: 'In HubSpot.', requestKey: 'req_12345678' })),
    ).rejects.toMatchObject({ url: `/app/tasks/${TASK}` })
    expect(db.rpcCalls).toEqual([
      { name: 'assign_employee_task', args: { p_employee_id: EMPLOYEE, p_title: 'Find Dana', p_instructions: 'In HubSpot.', p_idempotency_key: 'req_12345678' } },
    ])
    expect(scheduled).toHaveBeenCalledTimes(1)
  })

  it('validates input and the session before calling the database', async () => {
    expect(await actions.assignTask({ status: 'idle' }, form({ employeeId: 'nope', title: 'x' }))).toMatchObject({ status: 'error' })
    expect(await actions.assignTask({ status: 'idle' }, form({ employeeId: EMPLOYEE, title: '' }))).toMatchObject({ status: 'error', fieldErrors: { title: expect.any(Array) } })
    signedIn = false
    expect(await actions.assignTask({ status: 'idle' }, form({ employeeId: EMPLOYEE, title: 'Find Dana' }))).toMatchObject({ status: 'error', code: 'session_ended' })
    expect(db.rpcCalls).toEqual([])
  })

  it('explains the database’s refusals', async () => {
    for (const [code, text] of [
      ['P0002', 'your role can’t assign'],
      ['55000', 'Only an active employee'],
      ['23514', 'looks like a password'],
    ] as const) {
      db.rpcHandlers.assign_employee_task = () => ({ data: null, error: { code } })
      expect(await actions.assignTask({ status: 'idle' }, form({ employeeId: EMPLOYEE, title: 'Find Dana' }))).toMatchObject({ status: 'error', message: expect.stringContaining(text) })
    }
    expect(scheduled).not.toHaveBeenCalled()
  })
})

describe('cancelling and replying', () => {
  it('cancels through cancel_employee_task and says when a running task stops later', async () => {
    db.rpcHandlers.cancel_employee_task = () => ({ data: 'cancel_requested', error: null })
    expect(await actions.cancelTask(TASK)).toMatchObject({ status: 'success', message: expect.stringContaining('current step') })
    db.rpcHandlers.cancel_employee_task = () => ({ data: null, error: { code: '55000' } })
    expect(await actions.cancelTask(TASK)).toMatchObject({ status: 'error', message: expect.stringContaining('already finished') })
    expect(await actions.cancelTask('not-a-uuid')).toMatchObject({ status: 'error' })
  })

  it('replies through reply_to_employee_task and nudges the runtime', async () => {
    db.rpcHandlers.reply_to_employee_task = () => ({ data: 'queued', error: null })
    expect(await actions.replyToTask({ status: 'idle' }, form({ taskId: TASK, message: 'Use dana@example.com' }))).toMatchObject({ status: 'success' })
    expect(db.rpcCalls.at(-1)).toEqual({ name: 'reply_to_employee_task', args: { p_task_id: TASK, p_message: 'Use dana@example.com' } })
    expect(scheduled).toHaveBeenCalledTimes(1)
    db.rpcHandlers.reply_to_employee_task = () => ({ data: null, error: { code: '55000' } })
    expect(await actions.replyToTask({ status: 'idle' }, form({ taskId: TASK, message: 'Again' }))).toMatchObject({ status: 'error', message: expect.stringContaining('isn’t waiting') })
  })
})

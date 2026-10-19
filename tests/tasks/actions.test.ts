// Task Server Actions with the session and database replaced by fakes: the
// session is confirmed first, input is validated on the server, the work goes
// through the SQL functions under the user's session (which check role and
// state — pgTAP 009 and 010), their errors become plain messages, cancelling
// says what it couldn't undo, and the runtime is nudged after the response.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeSupabase } from '../helpers/fake-supabase'

const EMPLOYEE = 'a2000000-0000-4000-8000-000000000001'
const TASK = 'a7000000-0000-4000-8000-000000000001'
const OTHER_TASK = 'a7000000-0000-4000-8000-000000000002'

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
      {
        name: 'assign_employee_task',
        args: { p_employee_id: EMPLOYEE, p_title: 'Find Dana', p_instructions: 'In HubSpot.', p_idempotency_key: 'req_12345678', p_priority: 0, p_depends_on: [], p_timeout_minutes: 4320 },
      },
    ])
    expect(scheduled).toHaveBeenCalledWith({ reason: 'assigned' })
  })

  it('passes priority, deadline and every task it should start after', async () => {
    db.rpcHandlers.assign_employee_task = () => ({ data: TASK, error: null })
    const data = form({ employeeId: EMPLOYEE, title: 'Tell sales', priority: '50', timeoutMinutes: '60' })
    data.append('dependsOn', OTHER_TASK)
    data.append('dependsOn', TASK)
    await expect(actions.assignTask({ status: 'idle' }, data)).rejects.toMatchObject({ url: `/app/tasks/${TASK}` })
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_priority: 50, p_timeout_minutes: 60, p_depends_on: [OTHER_TASK, TASK] })

    expect(await actions.assignTask({ status: 'idle' }, form({ employeeId: EMPLOYEE, title: 'x', priority: '500' }))).toMatchObject({ status: 'error' })
    expect(await actions.assignTask({ status: 'idle' }, form({ employeeId: EMPLOYEE, title: 'x', timeoutMinutes: '1' }))).toMatchObject({ status: 'error' })
    const bad = form({ employeeId: EMPLOYEE, title: 'x' })
    bad.append('dependsOn', 'not-a-task')
    expect(await actions.assignTask({ status: 'idle' }, bad)).toMatchObject({ status: 'error' })
    expect(db.rpcCalls).toHaveLength(1)
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

describe('controlling a task', () => {
  it('cancels through cancel_employee_task and says when a running task stops later', async () => {
    db.rpcHandlers.cancel_employee_task = () => ({ data: 'cancel_requested', error: null })
    expect(await actions.cancelTask(TASK)).toMatchObject({ status: 'success', message: expect.stringContaining('after the current one') })
    db.rpcHandlers.cancel_employee_task = () => ({ data: null, error: { code: '55000' } })
    expect(await actions.cancelTask(TASK)).toMatchObject({ status: 'error', message: expect.stringContaining('state changed') })
    expect(await actions.cancelTask('not-a-uuid')).toMatchObject({ status: 'error' })
  })

  it('says plainly which actions already happened and can’t be undone, and which may still complete', async () => {
    db.rpcHandlers.cancel_employee_task = () => ({ data: 'cancelled', error: null })
    db.tables.tool_executions = [
      { id: 'x1', task_id: TASK, tool_key: 'hubspot.contacts.upsert', risk_level: 'write_external', status: 'succeeded' },
      { id: 'x2', task_id: TASK, tool_key: 'hubspot.contacts.search', risk_level: 'read', status: 'succeeded' },
      { id: 'x3', task_id: TASK, tool_key: 'slack.messages.post', risk_level: 'write_external', status: 'executing' },
    ]
    const result = await actions.cancelTask(TASK)
    expect(result).toMatchObject({ status: 'success' })
    const message = (result as { message: string }).message
    expect(message).toContain('1 action had already been carried out (hubspot.contacts.upsert) and can’t be undone')
    expect(message).toContain('1 action was running and may still complete')
    expect(message).not.toContain('contacts.search')
  })

  it('pauses, resumes and retries through the SQL functions; resuming and retrying nudge the runtime', async () => {
    db.rpcHandlers.pause_employee_task = () => ({ data: 'pause_requested', error: null })
    expect(await actions.pauseTask(TASK)).toMatchObject({ status: 'success', message: expect.stringContaining('after the current step') })
    db.rpcHandlers.resume_employee_task = () => ({ data: 'queued', error: null })
    expect(await actions.resumeTask(TASK)).toMatchObject({ status: 'success', message: expect.stringContaining('continues from where it stopped') })
    db.rpcHandlers.retry_employee_task = () => ({ data: 'queued', error: null })
    expect(await actions.retryTask(TASK)).toMatchObject({ status: 'success', message: expect.stringContaining('not repeated') })
    expect(scheduled.mock.calls).toEqual([[{ reason: 'resumed' }], [{ reason: 'retried' }]])
    expect(db.rpcCalls.map((call) => call.name)).toEqual(['pause_employee_task', 'resume_employee_task', 'retry_employee_task'])

    db.rpcHandlers.retry_employee_task = () => ({ data: null, error: { code: 'P0002' } })
    expect(await actions.retryTask(TASK)).toMatchObject({ status: 'error', message: expect.stringContaining('your role') })
    signedIn = false
    expect(await actions.pauseTask(TASK)).toMatchObject({ status: 'error', code: 'session_ended' })
  })

  it('changes priority and reassigns, explaining refusals', async () => {
    db.rpcHandlers.set_employee_task_priority = () => ({ data: 20, error: null })
    expect(await actions.setTaskPriority({ status: 'idle' }, form({ taskId: TASK, priority: '20' }))).toMatchObject({ status: 'success' })
    expect(await actions.setTaskPriority({ status: 'idle' }, form({ taskId: TASK, priority: 'high' }))).toMatchObject({ status: 'error' })
    db.rpcHandlers.reassign_employee_task = () => ({ data: null, error: { code: '55000' } })
    expect(await actions.reassignTask({ status: 'idle' }, form({ taskId: TASK, employeeId: EMPLOYEE }))).toMatchObject({ status: 'error', message: expect.stringContaining('hasn’t started') })
    db.rpcHandlers.reassign_employee_task = () => ({ data: 'reassigned', error: null })
    expect(await actions.reassignTask({ status: 'idle' }, form({ taskId: TASK, employeeId: EMPLOYEE }))).toMatchObject({ status: 'success' })
    expect(db.rpcCalls.at(-1)).toEqual({ name: 'reassign_employee_task', args: { p_task_id: TASK, p_employee_id: EMPLOYEE } })
  })

  it('replies through reply_to_employee_task and nudges the runtime', async () => {
    db.rpcHandlers.reply_to_employee_task = () => ({ data: 'queued', error: null })
    expect(await actions.replyToTask({ status: 'idle' }, form({ taskId: TASK, message: 'Use dana@example.com' }))).toMatchObject({ status: 'success' })
    expect(db.rpcCalls.at(-1)).toEqual({ name: 'reply_to_employee_task', args: { p_task_id: TASK, p_message: 'Use dana@example.com' } })
    expect(scheduled).toHaveBeenCalledWith({ reason: 'replied' })
    db.rpcHandlers.reply_to_employee_task = () => ({ data: null, error: { code: '55000' } })
    expect(await actions.replyToTask({ status: 'idle' }, form({ taskId: TASK, message: 'Again' }))).toMatchObject({ status: 'error', message: expect.stringContaining('isn’t waiting') })
  })
})

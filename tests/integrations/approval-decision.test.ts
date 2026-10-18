// Approving and rejecting: the decision goes through decide_approval under the
// user's session (role, expiry and payload fingerprint are checked in SQL,
// pgTAP 007), an approval schedules the run, a rejection closes the task.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeSupabase } from '../helpers/fake-supabase'
import { ORG, USER } from '../helpers/integration-fixtures'

let db: FakeSupabase
let signedIn = true
const scheduleApprovedExecutions = vi.fn()
const closeRejectedTask = vi.fn(async (_org: string, _task: string) => {})

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createUserClient: async () =>
    Object.assign(db, { auth: { getUser: async () => (signedIn ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: {} }) } }),
}))
vi.mock('@/modules/integrations/server/scheduling', () => ({
  scheduleApprovedExecutions: () => scheduleApprovedExecutions(),
  closeRejectedTask: (org: string, task: string) => closeRejectedTask(org, task),
}))

const { decideApproval } = await import('@/modules/governance/server/approval-actions')

const REQUEST = '99999999-9999-4999-8999-999999999999'
const TASK = '77777777-7777-4777-8777-777777777777'
const HASH = 'a'.repeat(64)

function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries({ requestId: REQUEST, payloadSha256: HASH, decision: 'approved', ...values })) data.set(key, value)
  return data
}

beforeEach(() => {
  db = new FakeSupabase()
  signedIn = true
  scheduleApprovedExecutions.mockClear()
  closeRejectedTask.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('decideApproval', () => {
  it('rejects malformed input and ended sessions before calling the database', async () => {
    expect(await decideApproval({ status: 'idle' }, form({ payloadSha256: 'short' }))).toMatchObject({ status: 'error' })
    expect(await decideApproval({ status: 'idle' }, form({ decision: 'maybe' }))).toMatchObject({ status: 'error' })
    signedIn = false
    expect(await decideApproval({ status: 'idle' }, form({}))).toMatchObject({ code: 'session_ended' })
    expect(db.rpcCalls).toEqual([])
  })

  it('approves with the fingerprint the approver saw and schedules the run', async () => {
    db.rpcHandlers.decide_approval = () => ({ data: { status: 'approved', organization_id: ORG, task_id: TASK }, error: null })
    expect(await decideApproval({ status: 'idle' }, form({ note: ' looks right ' }))).toMatchObject({ status: 'success' })
    expect(db.rpcCalls[0]).toEqual({ name: 'decide_approval', args: { p_request_id: REQUEST, p_decision: 'approved', p_payload_sha256: HASH, p_note: 'looks right' } })
    expect(scheduleApprovedExecutions).toHaveBeenCalledOnce()
    expect(closeRejectedTask).not.toHaveBeenCalled()
  })

  it('rejects and closes the waiting task', async () => {
    db.rpcHandlers.decide_approval = () => ({ data: { status: 'rejected', organization_id: ORG, task_id: TASK }, error: null })
    expect(await decideApproval({ status: 'idle' }, form({ decision: 'rejected' }))).toMatchObject({ status: 'success', message: expect.stringContaining('will not run') })
    expect(closeRejectedTask).toHaveBeenCalledWith(ORG, TASK)
    expect(scheduleApprovedExecutions).not.toHaveBeenCalled()
  })

  it('explains refusals from the database', async () => {
    db.rpcHandlers.decide_approval = () => ({ data: null, error: { code: '40001' } })
    expect(await decideApproval({ status: 'idle' }, form({}))).toMatchObject({ message: expect.stringContaining('changed after you opened it') })
    db.rpcHandlers.decide_approval = () => ({ data: null, error: { code: 'P0002' } })
    expect(await decideApproval({ status: 'idle' }, form({}))).toMatchObject({ message: expect.stringContaining('higher role') })
    db.rpcHandlers.decide_approval = () => ({ data: { status: 'expired', organization_id: ORG, task_id: TASK }, error: null })
    expect(await decideApproval({ status: 'idle' }, form({}))).toMatchObject({ status: 'error', message: expect.stringContaining('expired') })
    expect(scheduleApprovedExecutions).not.toHaveBeenCalled()
  })
})

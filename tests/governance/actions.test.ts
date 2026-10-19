// Governance Server Actions with the session and database replaced by fakes:
// roles are checked before anything is written, input from the browser is
// validated, and each action passes exactly the verified values to the SQL
// function (which checks role and state again; see pgTAP 013 and
// tests/integration/governance.test.ts for those checks against PostgreSQL).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrganizationRole } from '@/lib/supabase/types'

import { FakeSupabase } from '../helpers/fake-supabase'

const ORG = 'a1000000-0000-4000-8000-000000000000'
const USER = 'a0000000-0000-4000-8000-000000000002'
const EMPLOYEE = 'a2000000-0000-4000-8000-000000000001'
const TASK = 'a7000000-0000-4000-8000-000000000001'

let db: FakeSupabase
let role: OrganizationRole | null = 'admin'
let calls: { name: string; args: Record<string, unknown> }[] = []

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/modules/tasks/server/scheduling', () => ({ scheduleTaskProcessing: vi.fn() }))
vi.mock('@/modules/integrations/server/membership', () => ({
  getVerifiedMember: async () => (role ? { status: 'ok', user: { id: USER, email: null }, role } : { status: 'not_member' }),
}))
vi.mock('@/lib/supabase/server', () => ({ createUserClient: async () => db }))

const actions = await import('@/modules/governance/server/actions')

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

function record(name: string, result: { data: unknown; error: unknown } = { data: null, error: null }) {
  db.rpcHandlers[name] = (args) => {
    calls.push({ name, args })
    return result
  }
}

beforeEach(() => {
  db = new FakeSupabase()
  role = 'admin'
  calls = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const idle = { status: 'idle' } as const

describe('savePolicy', () => {
  const input = (document: unknown, settings: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    policyId: null,
    settings: { name: 'CRM upkeep', description: '', enabled: true, priority: 10, ...settings },
    document,
  })

  it('lets only admins and owners save, and validates the document on the server', async () => {
    role = 'operator'
    expect(await actions.savePolicy(input({ rules: [] }))).toMatchObject({ status: 'error', message: expect.stringContaining('admins') })
    role = 'admin'
    expect(await actions.savePolicy(input({ rules: [{ effect: 'allow', categories: ['record_change'] }] }))).toMatchObject({
      status: 'error',
      message: expect.stringContaining('must name the actions'),
    })
    expect(await actions.savePolicy({ ...input({ rules: [] }), organizationId: 'nope' })).toMatchObject({ status: 'error' })
    expect(db.tables.organization_policies).toBeUndefined()
  })

  it('inserts a version 2 document scoped to the workspace, through the member’s own session', async () => {
    const result = await actions.savePolicy(input({ rules: [{ effect: 'allow', toolKeys: ['hubspot.contacts.upsert'] }], limits: { maxCostUsdPerTask: 1 } }))
    expect(result).toMatchObject({ status: 'success', message: expect.stringContaining('revision') })
    expect(db.tables.organization_policies![0]).toMatchObject({
      organization_id: ORG,
      name: 'CRM upkeep',
      policy_schema_version: 2,
      policy: { rules: [{ effect: 'allow', toolKeys: ['hubspot.contacts.upsert'] }], limits: { maxCostUsdPerTask: 1 } },
    })
    // The browser can't choose who authorized it.
    expect(db.tables.organization_policies![0]!.authorized_role).toBeUndefined()
  })
})

describe('emergency stop', () => {
  it('needs a reason and the typed confirmation before calling the database', async () => {
    expect(await actions.setEmergencyStop(idle, form({ organizationId: ORG, reason: '', confirm: 'STOP' }))).toMatchObject({ status: 'error' })
    expect(await actions.setEmergencyStop(idle, form({ organizationId: ORG, reason: 'Wrong emails', confirm: 'stp' }))).toMatchObject({ message: 'Type STOP to confirm.' })
    role = 'operator'
    expect(await actions.setEmergencyStop(idle, form({ organizationId: ORG, reason: 'Wrong emails', confirm: 'STOP' }))).toMatchObject({ status: 'error' })
    expect(calls).toEqual([])
  })

  it('stops and reports what stopped; lifting passes the resume choice', async () => {
    record('set_emergency_stop', { data: { paused_tasks: 2, stopping_tasks: 1, withdrawn_actions: 3, cancelled_runs: 1 }, error: null })
    const stopped = await actions.setEmergencyStop(idle, form({ organizationId: ORG, reason: 'Wrong emails', confirm: 'stop' }))
    expect(stopped).toMatchObject({ status: 'success', message: expect.stringContaining('2 task(s) paused') })
    expect(calls[0]).toEqual({ name: 'set_emergency_stop', args: { p_organization_id: ORG, p_reason: 'Wrong emails' } })

    record('lift_emergency_stop', { data: { resumed_tasks: 2 }, error: null })
    expect(await actions.liftEmergencyStop(idle, form({ organizationId: ORG, resumeTasks: 'on' }))).toMatchObject({ status: 'success', message: expect.stringContaining('2 paused task(s) resumed') })
    expect(calls[1]!.args).toEqual({ p_organization_id: ORG, p_resume_tasks: true })
  })

  it('explains the database’s refusals', async () => {
    record('set_emergency_stop', { data: null, error: { code: '55000' } })
    expect(await actions.setEmergencyStop(idle, form({ organizationId: ORG, reason: 'Again', confirm: 'STOP' }))).toMatchObject({ message: expect.stringContaining('already on') })
    record('emergency_stop_employee', { data: null, error: { code: 'P0002' } })
    expect(await actions.emergencyStopEmployee(idle, form({ employeeId: EMPLOYEE, reason: 'Loops' }))).toMatchObject({ message: expect.stringContaining('viewers') })
  })
})

describe('revocation, handoff and retention', () => {
  it('revokes exactly the named grant', async () => {
    expect(await actions.revokeEmployeeTool('nope', 'slack.messages.post', null)).toMatchObject({ status: 'error' })
    record('revoke_employee_tool', { data: 1, error: null })
    expect(await actions.revokeEmployeeTool(EMPLOYEE, 'slack.messages.post', null)).toMatchObject({ status: 'success' })
    expect(calls[0]!.args).toEqual({ p_employee_id: EMPLOYEE, p_tool_key: 'slack.messages.post' })
  })

  it('hands a task over and completes it, with the database deciding who may', async () => {
    record('hand_off_employee_task')
    expect(await actions.handOffTask(idle, form({ taskId: TASK, assignee: USER, note: 'Calling them' }))).toMatchObject({ status: 'success' })
    expect(calls[0]!.args).toEqual({ p_task_id: TASK, p_assignee: USER, p_note: 'Calling them' })
    record('complete_handed_off_task', { data: null, error: { code: '42501' } })
    expect(await actions.completeHandedOffTask(idle, form({ taskId: TASK, outcome: 'done' }))).toMatchObject({ message: expect.stringContaining('Only the person') })
    expect(await actions.completeHandedOffTask(idle, form({ taskId: TASK, outcome: 'maybe' }))).toMatchObject({ status: 'error', message: 'Choose an outcome.' })
  })

  it('validates retention bounds, and an empty field keeps the data', async () => {
    expect(await actions.saveRetention(idle, form({ organizationId: ORG, evidenceDays: '7', eventDays: '', payloadDays: '' }))).toMatchObject({ message: expect.stringContaining('30 days') })
    record('set_retention_settings')
    expect(await actions.saveRetention(idle, form({ organizationId: ORG, evidenceDays: '90', eventDays: '', payloadDays: '365', hold: 'on' }))).toMatchObject({ status: 'success' })
    expect(calls.at(-1)!.args).toEqual({ p_organization_id: ORG, p_evidence_days: 90, p_event_days: null, p_payload_days: 365, p_hold: true })
    role = 'operator'
    expect(await actions.saveRetention(idle, form({ organizationId: ORG, evidenceDays: '90', eventDays: '', payloadDays: '' }))).toMatchObject({ status: 'error' })
  })
})

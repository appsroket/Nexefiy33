// Employee Server Actions with the session, database and model replaced by
// fakes: roles are checked before anything happens, drafts and saves are
// validated on the server (schema and real tools/connections), saving and
// status changes go through the SQL functions under the user's session, and
// activation is refused while a tool has no usable connection.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrganizationRole } from '@/lib/supabase/types'
import { buildTemplateDraft, EMPLOYEE_TEMPLATES } from '@/modules/employees/domain/templates'
import { listEmployeeTools } from '@/modules/employees/server/tools'

import { FakeSupabase } from '../helpers/fake-supabase'

const ORG = 'a1000000-0000-4000-8000-000000000000'
const USER = 'a0000000-0000-4000-8000-000000000003'
const EMPLOYEE = 'a2000000-0000-4000-8000-000000000001'
const VERSION = 'a2000000-0000-4000-8000-000000000002'
const HUBSPOT = '11111111-1111-4111-8111-111111111111'
const SLACK = '22222222-2222-4222-8222-222222222222'
const FOREIGN = '99999999-9999-4999-8999-999999999999'

let db: FakeSupabase
let role: OrganizationRole | null = 'operator'
let signedIn = true
let modelConfigured = false
const structured = vi.fn()

const redirect = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { url })
})

vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/modules/integrations/server/membership', () => ({
  getVerifiedMember: async () => (!signedIn ? { status: 'signed_out' } : role ? { status: 'ok', user: { id: USER, email: null }, role } : { status: 'not_member' }),
}))
vi.mock('@/lib/supabase/server', () => ({ createUserClient: async () => db }))
vi.mock('@/modules/employees/server/queries', () => ({
  loadEditorOptions: async () => ({
    connections: [
      { id: HUBSPOT, provider: 'hubspot', label: 'Test portal', status: 'connected' },
      { id: SLACK, provider: 'slack', label: 'Test workspace', status: 'connected' },
    ],
    sources: [],
    skills: [
      { key: 'crm.records', name: 'CRM', description: null, toolKeys: [] },
      { key: 'chat.messaging', name: 'Chat', description: null, toolKeys: [] },
      { key: 'knowledge.search', name: 'Knowledge', description: null, toolKeys: [] },
    ],
  }),
}))
vi.mock('@/modules/models/server/provider', () => ({
  isModelConfigured: () => modelConfigured,
  getModelGateway: () => ({ provider: 'anthropic', turn: vi.fn(), structured }),
}))

const actions = await import('@/modules/employees/server/actions')

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

function salesDraft(connection: string | null = HUBSPOT) {
  return buildTemplateDraft(EMPLOYEE_TEMPLATES.find((template) => template.key === 'sales_operations')!, listEmployeeTools(), (provider) =>
    provider === 'hubspot' ? connection : provider === 'slack' ? SLACK : null,
  )
}

beforeEach(() => {
  db = new FakeSupabase()
  role = 'operator'
  signedIn = true
  modelConfigured = false
  structured.mockReset()
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('drafting', () => {
  it('needs an operator and a real description', async () => {
    role = 'viewer'
    expect(await actions.draftEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, description: 'A sales helper for leads' }))).toMatchObject({ status: 'error' })
    role = 'operator'
    expect(await actions.draftEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, description: 'short' }))).toMatchObject({ status: 'error' })
    expect(await actions.draftEmployeeAction({ status: 'idle' }, form({ organizationId: 'nope', description: 'A sales helper for leads' }))).toMatchObject({ status: 'error' })
  })

  it('drafts with keyword rules when no model is configured, filling the only connection of each provider', async () => {
    const state = await actions.draftEmployeeAction(
      { status: 'idle' },
      form({ organizationId: ORG, description: 'Create a sales operations employee that checks for CRM duplicates and requests approval before sending.' }),
    )
    expect(state).toMatchObject({ status: 'ready', source: 'rules' })
    if (state.status !== 'ready') throw new Error('expected a draft')
    expect(state.draft.config.tools).toEqual([{ toolKey: 'hubspot.contacts.search', integrationId: HUBSPOT, approval: 'allow' }])
    expect(structured).not.toHaveBeenCalled()
  })

  it('uses the model when configured, removing tools that don’t exist', async () => {
    modelConfigured = true
    structured.mockResolvedValue({
      value: {
        name: 'Sales Ops',
        department: 'sales',
        description: 'Keeps the CRM clean',
        responsibilities: ['Check for duplicates'],
        instructions: 'You keep the CRM clean.',
        toolKeys: ['hubspot.contacts.search', 'gmail.send'],
        successCriteria: ['No duplicates'],
        prohibitedActions: [],
        escalationWhen: [],
        escalationBehavior: 'stop_and_report',
        usesKnowledge: false,
        modelTier: 'fast',
        unsupportedRequests: ['Sending email'],
      },
      model: 'claude-opus-5-5',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    const state = await actions.draftEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, description: 'A sales helper that emails leads and checks HubSpot.' }))
    if (state.status !== 'ready') throw new Error('expected a draft')
    expect(state.source).toBe('model')
    expect(state.draft.config.tools.map((grant) => grant.toolKey)).toEqual(['hubspot.contacts.search'])
    expect(state.draft.config.model.tier).toBe('fast')
    expect(state.unsupported).toEqual(['Sending email', expect.stringContaining('gmail.send')])
    expect(structured.mock.calls[0]![0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  })

  it('starts from a template', async () => {
    const state = await actions.draftEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, templateKey: 'sales_operations' }))
    expect(state).toMatchObject({ status: 'ready', source: 'template', unsupported: [expect.stringContaining('email')] })
  })
})

describe('saving', () => {
  it('creates the employee through create_employee and opens it', async () => {
    db.rpcHandlers.create_employee = () => ({ data: EMPLOYEE, error: null })
    await expect(actions.saveEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, draft: JSON.stringify(salesDraft()) }))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith(`/app/employees/${EMPLOYEE}?saved=1`)
    expect(db.rpcCalls[0]).toMatchObject({ name: 'create_employee', args: { p_organization_id: ORG, p_change_note: 'First version' } })
  })

  it('validates the draft on the server before calling the database', async () => {
    const invalid = salesDraft()
    invalid.config.limits.maxCostUsdPerTask = 0
    const schema = await actions.saveEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, draft: JSON.stringify(invalid) }))
    expect(schema).toMatchObject({ status: 'error', issues: [expect.objectContaining({ path: 'config.limits.maxCostUsdPerTask' })] })

    const foreign = salesDraft(FOREIGN)
    const semantic = await actions.saveEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, draft: JSON.stringify(foreign) }))
    expect(semantic).toMatchObject({ status: 'error', issues: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('doesn’t exist in this workspace') })]) })

    const fake = salesDraft()
    fake.config.tools.push({ toolKey: 'gmail.send', integrationId: null, approval: 'require_approval' })
    expect(await actions.saveEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, draft: JSON.stringify(fake) }))).toMatchObject({ status: 'error' })
    expect(await actions.saveEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, draft: '{not json' }))).toMatchObject({ status: 'error' })
    expect(db.rpcCalls).toEqual([])
  })

  it('refuses viewers and requires the version an edit started from', async () => {
    role = 'viewer'
    expect(await actions.saveEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, draft: JSON.stringify(salesDraft()) }))).toMatchObject({ status: 'error', message: expect.stringContaining('Viewers') })
    role = 'operator'
    expect(await actions.saveEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, employeeId: EMPLOYEE, draft: JSON.stringify(salesDraft()) }))).toMatchObject({ status: 'error' })
    expect(db.rpcCalls).toEqual([])
  })

  it('saves a new version and explains conflicts', async () => {
    db.rpcHandlers.save_employee_version = () => ({ data: null, error: { code: '40001' } })
    const stale = await actions.saveEmployeeAction(
      { status: 'idle' },
      form({ organizationId: ORG, employeeId: EMPLOYEE, basedOnVersionId: VERSION, draft: JSON.stringify(salesDraft()), changeNote: 'Tweak' }),
    )
    expect(stale).toMatchObject({ status: 'error', message: expect.stringContaining('newer version') })
    expect(db.rpcCalls[0]).toMatchObject({ name: 'save_employee_version', args: { p_employee_id: EMPLOYEE, p_based_on_version_id: VERSION, p_change_note: 'Tweak' } })

    db.rpcHandlers.save_employee_version = () => ({ data: { version_id: 'v', version: 2 }, error: null })
    await expect(
      actions.saveEmployeeAction({ status: 'idle' }, form({ organizationId: ORG, employeeId: EMPLOYEE, basedOnVersionId: VERSION, draft: JSON.stringify(salesDraft()) })),
    ).rejects.toThrow('NEXT_REDIRECT')
  })
})

describe('status changes', () => {
  it('checks the role for each action before calling the database', async () => {
    role = 'operator'
    expect(await actions.changeEmployeeStatus(ORG, EMPLOYEE, 'activate', { versionId: VERSION, confirmName: 'Sales Ops' })).toMatchObject({ status: 'error', message: expect.stringContaining('admins') })
    expect(await actions.changeEmployeeStatus(ORG, EMPLOYEE, 'archive')).toMatchObject({ status: 'error' })
    expect(await actions.changeEmployeeStatus(ORG, EMPLOYEE, 'explode')).toMatchObject({ status: 'error' })
    expect(db.rpcCalls).toEqual([])

    db.rpcHandlers.change_employee_status = () => ({ data: { status: 'paused' }, error: null })
    expect(await actions.changeEmployeeStatus(ORG, EMPLOYEE, 'pause')).toMatchObject({ status: 'success' })
    expect(db.rpcCalls[0]).toEqual({ name: 'change_employee_status', args: { p_employee_id: EMPLOYEE, p_action: 'pause' } })
  })

  it('refuses activation while a tool has no connection, then passes version and confirmation through', async () => {
    role = 'admin'
    db.tables.employee_versions = [{ id: VERSION, employee_id: EMPLOYEE, organization_id: ORG, config_schema_version: 2, config: salesDraft(null).config }]
    const blocked = await actions.changeEmployeeStatus(ORG, EMPLOYEE, 'activate', { versionId: VERSION, confirmName: 'Sales Ops' })
    expect(blocked).toMatchObject({ status: 'error', message: expect.stringContaining('choose which HubSpot connection') })
    expect(db.rpcCalls).toEqual([])

    db.tables.employee_versions = [{ id: VERSION, employee_id: EMPLOYEE, organization_id: ORG, config_schema_version: 2, config: salesDraft().config }]
    db.rpcHandlers.change_employee_status = () => ({ data: null, error: { code: '23514' } })
    expect(await actions.changeEmployeeStatus(ORG, EMPLOYEE, 'activate', { versionId: VERSION, confirmName: 'Sales Ops' })).toMatchObject({ message: expect.stringContaining('tests') })
    expect(db.rpcCalls[0]).toEqual({ name: 'change_employee_status', args: { p_employee_id: EMPLOYEE, p_action: 'activate', p_version_id: VERSION, p_confirm_name: 'Sales Ops' } })
  })
})

describe('test runs and reviews', () => {
  it('refuses to run without a configured model (nothing is simulated)', async () => {
    const state = await actions.runTestAction({ status: 'idle' }, form({ organizationId: ORG, employeeId: EMPLOYEE, input: 'Hello' }))
    expect(state).toMatchObject({ status: 'error', message: expect.stringContaining('No AI model') })
  })

  it('lets operators review runs through review_employee_test_run', async () => {
    role = 'viewer'
    expect(await actions.reviewTestRun(ORG, EMPLOYEE, VERSION, 'passed')).toMatchObject({ status: 'error' })
    role = 'operator'
    db.rpcHandlers.review_employee_test_run = () => ({ data: 'passed', error: null })
    expect(await actions.reviewTestRun(ORG, EMPLOYEE, VERSION, 'passed', ' fine ')).toMatchObject({ status: 'success' })
    expect(db.rpcCalls[0]).toEqual({ name: 'review_employee_test_run', args: { p_run_id: VERSION, p_verdict: 'passed', p_note: 'fine' } })
  })

  it('saves test cases with only known tools in their expectations', async () => {
    const data = form({ organizationId: ORG, employeeId: EMPLOYEE, name: 'Duplicate check', input: 'A lead came in.', replyMustMention: 'exists\n\nHubSpot' })
    data.append('mustUseTools', 'hubspot.contacts.search')
    data.append('mustUseTools', 'gmail.send')
    expect(await actions.saveTestCaseAction({ status: 'idle' }, data)).toMatchObject({ status: 'success' })
    expect(db.tables.employee_test_cases![0]).toMatchObject({
      organization_id: ORG,
      employee_id: EMPLOYEE,
      expectations: { mustUseTools: ['hubspot.contacts.search'], replyMustMention: ['exists', 'HubSpot'] },
    })
  })
})

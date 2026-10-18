// The test-mode tool invoker, with the integration executor and knowledge
// retrieval replaced by fakes: inputs are validated, writes are never run
// (only described), the employee's approval rule can only add approval, and
// reads that would run without approval go through requestAction with the
// tester as the actor.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EmployeeToolGrant } from '@/modules/employees/domain/types'
import { resolveTool } from '@/modules/employees/server/tools'

const preview = vi.fn()
const requestAction = vi.fn()
const retrieveKnowledge = vi.fn()

vi.mock('@/modules/integrations/server/executor', () => ({
  previewActionDecision: (...args: unknown[]) => preview(...args),
  requestAction: (...args: unknown[]) => requestAction(...args),
}))
vi.mock('@/modules/knowledge/server/retrieval', () => ({ retrieveKnowledge: (...args: unknown[]) => retrieveKnowledge(...args) }))

const { createTestToolInvoker } = await import('@/modules/employees/server/test-invoker')

const ORG = 'a1000000-0000-4000-8000-000000000000'
const EMPLOYEE = 'a2000000-0000-4000-8000-000000000001'
const HUBSPOT = '11111111-1111-4111-8111-111111111111'
const actor = { kind: 'user' as const, userId: 'a0000000-0000-4000-8000-000000000003', role: 'operator' as const }
const integrations = { marker: 'runtime' } as never

function invoker(knowledge: 'none' | 'all' | 'selected' = 'all', withIntegrations = true) {
  return createTestToolInvoker({
    organizationId: ORG,
    employeeId: EMPLOYEE,
    runId: 'run-1',
    actor,
    knowledge: { access: knowledge, sourceIds: knowledge === 'selected' ? ['33333333-3333-4333-8333-333333333333'] : [], maxPassages: 4 },
    admin: {} as never,
    embedder: null,
    integrations: withIntegrations ? integrations : null,
  })
}

function call(toolKey: string, input: unknown, grant: Partial<EmployeeToolGrant> = {}) {
  return { grant: { toolKey, integrationId: HUBSPOT, approval: 'allow' as const, ...grant }, tool: resolveTool(toolKey)!, input, callId: 'toolu_1' }
}

beforeEach(() => {
  preview.mockReset()
  requestAction.mockReset()
  retrieveKnowledge.mockReset()
})

describe('test tool invoker', () => {
  it('rejects input that doesn’t match the tool’s schema before anything else', async () => {
    const outcome = await invoker().invoke(call('slack.messages.post', { channel: 'not-a-channel' }))
    expect(outcome).toMatchObject({ decision: 'refused', executed: false, isError: true, content: expect.stringContaining('Invalid input') })
    expect(preview).not.toHaveBeenCalled()
  })

  it('searches knowledge for real within the employee’s access, and refuses when access is off', async () => {
    retrieveKnowledge.mockResolvedValue({ query: 'refunds', verdict: 'sufficient', passages: [] })
    const outcome = await invoker('selected').invoke(call('knowledge.search', { query: 'refund policy' }, { integrationId: null }))
    expect(outcome).toMatchObject({ decision: 'allow', executed: true, isError: false })
    expect(retrieveKnowledge.mock.calls[0]![1]).toMatchObject({ organizationId: ORG, query: 'refund policy', sourceIds: ['33333333-3333-4333-8333-333333333333'], limit: 4 })

    const off = await invoker('none').invoke(call('knowledge.search', { query: 'refund policy' }, { integrationId: null }))
    expect(off).toMatchObject({ decision: 'refused', executed: false })
  })

  it('refuses integration tools without a connection or without integrations configured', async () => {
    expect(await invoker().invoke(call('hubspot.contacts.search', { email: 'jane@example.test' }, { integrationId: null }))).toMatchObject({ decision: 'refused' })
    expect(await invoker('all', false).invoke(call('hubspot.contacts.search', { email: 'jane@example.test' }))).toMatchObject({ decision: 'refused' })
    expect(preview).not.toHaveBeenCalled()
  })

  it('passes the connection’s refusal through', async () => {
    preview.mockResolvedValue({ status: 'refused', error: { code: 'reauth_required', message: 'Reconnect HubSpot.' } })
    expect(await invoker().invoke(call('hubspot.contacts.search', { email: 'jane@example.test' }))).toMatchObject({ decision: 'refused', content: 'Reconnect HubSpot.' })
    expect(preview.mock.calls[0]![1]).toEqual({ organizationId: ORG, integrationId: HUBSPOT, actionKey: 'hubspot.contacts.search', employeeId: EMPLOYEE })
  })

  it('never runs a write: it reports approval, a block, or that it would run', async () => {
    const input = { channel: 'C0123456', text: 'Hello team' }
    preview.mockResolvedValue({ status: 'ok', decision: 'require_approval', reason: 'Default for this action.' })
    expect(await invoker().invoke(call('slack.messages.post', input))).toMatchObject({ decision: 'require_approval', executed: false, content: expect.stringContaining('wait for approval') })
    preview.mockResolvedValue({ status: 'ok', decision: 'deny', reason: 'Workspace policy “No Slack”.' })
    expect(await invoker().invoke(call('slack.messages.post', input))).toMatchObject({ decision: 'deny', executed: false })
    preview.mockResolvedValue({ status: 'ok', decision: 'allow', reason: 'Connection setting for this action.' })
    expect(await invoker().invoke(call('slack.messages.post', input))).toMatchObject({ decision: 'allow', executed: false, content: expect.stringContaining('would run without approval') })
    expect(requestAction).not.toHaveBeenCalled()
  })

  it('lets the employee add approval to an action the connection would allow', async () => {
    preview.mockResolvedValue({ status: 'ok', decision: 'allow', reason: 'Default for this action.' })
    const outcome = await invoker().invoke(call('hubspot.contacts.search', { email: 'jane@example.test' }, { approval: 'require_approval' }))
    expect(outcome).toMatchObject({ decision: 'require_approval', executed: false })
    expect(requestAction).not.toHaveBeenCalled()
  })

  it('runs an allowed read through requestAction as the tester', async () => {
    preview.mockResolvedValue({ status: 'ok', decision: 'allow', reason: 'Default for this action.' })
    requestAction.mockResolvedValue({ status: 'succeeded', executionId: 'x', output: { contacts: [], total: 0 } })
    const outcome = await invoker().invoke(call('hubspot.contacts.search', { email: 'jane@example.test' }))
    expect(outcome).toEqual({ decision: 'allow', executed: true, isError: false, content: '{"contacts":[],"total":0}' })
    expect(requestAction.mock.calls[0]![1]).toMatchObject({
      organizationId: ORG,
      integrationId: HUBSPOT,
      actionKey: 'hubspot.contacts.search',
      input: { email: 'jane@example.test' },
      idempotencyKey: 'employee-test:run-1:toolu_1',
      actor,
    })
  })
})

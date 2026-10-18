// The shared runtime with a scripted model and a recording tool invoker:
// only granted tools reach the invoker, the assistant's content is passed
// back unchanged, and every limit (turns, tool calls, per-task cost, monthly
// budget, time) stops the run before it is crossed.

import { describe, expect, it, vi } from 'vitest'

import { buildTemplateDraft, EMPLOYEE_TEMPLATES } from '@/modules/employees/domain/templates'
import type { EmployeeConfig } from '@/modules/employees/domain/types'
import { runEmployee, type ToolInvoker } from '@/modules/employees/server/runtime'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { ModelError, type ModelGateway, type ModelTurnRequest, type ModelTurnResult } from '@/modules/models/server/gateway'

const HUBSPOT = '11111111-1111-4111-8111-111111111111'

function config(overrides: Partial<EmployeeConfig> = {}): EmployeeConfig {
  const base = buildTemplateDraft(EMPLOYEE_TEMPLATES.find((template) => template.key === 'sales_operations')!, listEmployeeTools(), () => HUBSPOT).config
  return { ...base, ...overrides }
}

type Step = Partial<ModelTurnResult> | Error

function scriptedGateway(steps: Step[]) {
  const requests: ModelTurnRequest[] = []
  const gateway: ModelGateway = {
    provider: 'anthropic',
    turn: vi.fn(async (request: ModelTurnRequest) => {
      // Copy: the runtime keeps appending to the same array.
      requests.push({ ...request, messages: [...request.messages] })
      const step = steps.shift()
      if (!step) throw new Error('no more scripted steps')
      if (step instanceof Error) throw step
      return {
        text: '',
        toolCalls: [],
        stopReason: 'end_turn' as const,
        model: 'claude-sonnet-5-5',
        usage: { inputTokens: 1000, outputTokens: 100 },
        assistantContent: [{ type: 'text', text: step.text ?? '' }],
        ...step,
      }
    }),
    structured: vi.fn(),
  }
  return { gateway, requests }
}

function recordingInvoker(): ToolInvoker & { calls: { toolKey: string; input: unknown }[] } {
  const calls: { toolKey: string; input: unknown }[] = []
  return {
    calls,
    async invoke({ grant, input }) {
      calls.push({ toolKey: grant.toolKey, input })
      return { decision: grant.approval, executed: grant.approval === 'allow', isError: false, content: `result for ${grant.toolKey}` }
    },
  }
}

function request(overrides: Partial<Parameters<typeof runEmployee>[0]> = {}) {
  return {
    employeeName: 'Sales Ops',
    organizationName: 'Acme',
    instructions: 'Keep the CRM clean.',
    config: config(),
    input: 'A lead from jane@example.test came in.',
    businessContext: null,
    budgetRemainingMicros: 25_000_000,
    ...overrides,
  }
}

describe('runEmployee', () => {
  it('answers, offering exactly the granted tools plus escalate, under provider-safe names', async () => {
    const { gateway, requests } = scriptedGateway([{ text: 'Done.' }])
    const result = await runEmployee(request(), { gateway, invoker: recordingInvoker() })
    expect(result).toMatchObject({ outcome: 'completed', reply: 'Done.', model: 'claude-sonnet-5-5' })
    expect(requests[0]!.model).toBe('claude-sonnet-5-5')
    expect(requests[0]!.effort).toBe('medium')
    expect(requests[0]!.tools.map((tool) => tool.name)).toEqual([
      'hubspot__contacts__search',
      'hubspot__contacts__upsert',
      'hubspot__notes__create',
      'slack__messages__post',
      'knowledge__search',
      'escalate',
    ])
    expect(requests[0]!.tools[0]!.inputSchema).toMatchObject({ type: 'object' })
    expect(requests[0]!.system).toContain('## Platform rules')
    // 1000 input × $2/M + 100 output × $10/M = 3000 micro-dollars.
    expect(result.costMicros).toBe(3000)
  })

  it('routes granted tool calls to the invoker and passes the assistant content back unchanged', async () => {
    const assistantContent = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'hubspot__contacts__search', input: {} }]
    const { gateway, requests } = scriptedGateway([
      { toolCalls: [{ id: 't1', name: 'hubspot__contacts__search', input: { email: 'jane@example.test' } }], stopReason: 'tool_use', assistantContent },
      { text: 'Jane is new; the contact needs approval to create.' },
    ])
    const invoker = recordingInvoker()
    const result = await runEmployee(request(), { gateway, invoker })
    expect(invoker.calls).toEqual([{ toolKey: 'hubspot.contacts.search', input: { email: 'jane@example.test' } }])
    expect(requests[1]!.messages[1]).toEqual({ role: 'assistant', content: assistantContent })
    expect(requests[1]!.messages[2]).toEqual({ role: 'tool_results', results: [{ toolCallId: 't1', content: 'result for hubspot.contacts.search', isError: false }] })
    expect(result.toolCalls).toEqual([{ toolKey: 'hubspot.contacts.search', decision: 'allow' }])
    expect(result.transcript.map((entry) => entry.kind)).toEqual(['request', 'tool_call', 'assistant'])
  })

  it('refuses tools that aren’t granted without calling the invoker', async () => {
    const { gateway } = scriptedGateway([
      { toolCalls: [{ id: 't1', name: 'slack__channels__list', input: {} }, { id: 't2', name: 'gmail__send', input: {} }], stopReason: 'tool_use' },
      { text: 'I can’t do that.' },
    ])
    const invoker = recordingInvoker()
    const result = await runEmployee(request(), { gateway, invoker })
    expect(invoker.calls).toEqual([])
    expect(result.transcript.filter((entry) => entry.kind === 'tool_call')).toEqual([
      expect.objectContaining({ toolKey: 'slack.channels.list', decision: 'refused', isError: true }),
      expect.objectContaining({ toolKey: 'gmail.send', decision: 'refused', isError: true }),
    ])
  })

  it('enforces the tool call limit', async () => {
    const { gateway } = scriptedGateway([
      {
        toolCalls: [
          { id: 'a', name: 'knowledge__search', input: { query: 'one' } },
          { id: 'b', name: 'knowledge__search', input: { query: 'two' } },
        ],
        stopReason: 'tool_use',
      },
      { text: 'ok' },
    ])
    const invoker = recordingInvoker()
    await runEmployee(request({ config: config({ limits: { ...config().limits, maxToolCallsPerTask: 1 } }) }), { gateway, invoker })
    expect(invoker.calls).toHaveLength(1)
  })

  it('ends with the escalation message when the employee escalates', async () => {
    const { gateway } = scriptedGateway([
      { text: 'Checking.', toolCalls: [{ id: 'e', name: 'escalate', input: { reason: 'missing email', message: 'Which email should I use?' } }], stopReason: 'tool_use' },
    ])
    const result = await runEmployee(request(), { gateway, invoker: recordingInvoker() })
    expect(result).toMatchObject({ outcome: 'escalated', reply: 'Which email should I use?' })
    expect(result.transcript.at(-1)).toEqual({ kind: 'escalation', reason: 'missing email', message: 'Which email should I use?' })
  })

  it('reports a refusal and a model error without throwing', async () => {
    expect((await runEmployee(request(), { gateway: scriptedGateway([{ stopReason: 'refusal' }]).gateway, invoker: recordingInvoker() })).outcome).toBe('refused')
    const failed = await runEmployee(request(), { gateway: scriptedGateway([new ModelError('rate_limited', 'Slow down.', true)]).gateway, invoker: recordingInvoker() })
    expect(failed).toMatchObject({ outcome: 'error', error: { code: 'rate_limited', message: 'Slow down.' } })
  })

  it('stops before a step could cross the per-task cost limit or the monthly budget', async () => {
    // Sonnet output is $10/M: 8000 max output tokens could cost $0.08.
    const tight = config({ limits: { ...config().limits, maxCostUsdPerTask: 0.05 } })
    const { gateway } = scriptedGateway([{ text: 'never' }])
    const capped = await runEmployee(request({ config: tight }), { gateway, invoker: recordingInvoker() })
    expect(capped.outcome).toBe('limit_reached')
    expect(gateway.turn).not.toHaveBeenCalled()

    const broke = await runEmployee(request({ budgetRemainingMicros: 10_000 }), { gateway, invoker: recordingInvoker() })
    expect(broke.outcome).toBe('limit_reached')
    expect(broke.transcript.at(-1)).toMatchObject({ reason: expect.stringContaining('budget') })
  })

  it('stops at the turn limit and the time limit', async () => {
    const loop = { toolCalls: [{ id: 'k', name: 'knowledge__search', input: { query: 'again' } }], stopReason: 'tool_use' as const }
    const turns = await runEmployee(request({ config: config({ limits: { ...config().limits, maxTurnsPerTask: 2 } }) }), {
      gateway: scriptedGateway([loop, loop]).gateway,
      invoker: recordingInvoker(),
    })
    expect(turns).toMatchObject({ outcome: 'limit_reached' })
    expect(turns.transcript.at(-1)).toMatchObject({ reason: expect.stringContaining('turn limit') })

    let clock = 0
    const timed = await runEmployee(request(), {
      gateway: scriptedGateway([loop, loop]).gateway,
      invoker: { invoke: async () => ((clock += 200_000), { decision: 'allow', executed: true, isError: false, content: '' }) },
      now: () => clock,
    })
    expect(timed.transcript.at(-1)).toMatchObject({ reason: expect.stringContaining('time limit') })
  })
})

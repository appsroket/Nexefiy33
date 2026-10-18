// The Anthropic gateway with a fake SDK client (contract test, written from
// the Claude API reference checked 2026-10-18 — not a live call): request
// shape for Claude 5.5 models (no temperature, no forced tool choice, effort
// in output_config), tool results grouped in one user message, stop reasons
// and usage, and SDK errors mapped without copying provider text.

import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createAnthropicGateway, toAnthropicMessages, toModelError } from '@/modules/models/server/anthropic'

function fakeClient(response: unknown) {
  const create = vi.fn(async (..._args: unknown[]) => response)
  const parse = vi.fn(async (..._args: unknown[]) => response)
  return { client: { messages: { create, parse } } as unknown as Anthropic, create, parse }
}

const MESSAGE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'Looking it up.' },
    { type: 'tool_use', id: 'toolu_1', name: 'hubspot__contacts__search', input: { email: 'jane@example.test' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 1200, output_tokens: 80 },
}

describe('Anthropic gateway', () => {
  it('sends a Claude 5.5 request without sampling parameters or forced tool choice', async () => {
    const { client, create } = fakeClient(MESSAGE)
    const gateway = createAnthropicGateway({ client })
    const result = await gateway.turn({
      model: 'claude-sonnet-5-5',
      system: 'rules',
      messages: [{ role: 'user', text: 'hi' }],
      tools: [{ name: 'hubspot__contacts__search', description: 'Find contacts', inputSchema: { type: 'object', properties: {} } }],
      maxOutputTokens: 8000,
      effort: 'medium',
    })
    const [body] = create.mock.calls[0]! as unknown as [Record<string, unknown>]
    expect(body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 8000,
      system: 'rules',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'hubspot__contacts__search', description: 'Find contacts', input_schema: { type: 'object', properties: {} } }],
      output_config: { effort: 'medium' },
    })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('tool_choice')
    expect(result).toEqual({
      text: 'Looking it up.',
      toolCalls: [{ id: 'toolu_1', name: 'hubspot__contacts__search', input: { email: 'jane@example.test' } }],
      stopReason: 'tool_use',
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 1200, outputTokens: 80 },
      assistantContent: MESSAGE.content,
    })
  })

  it('omits tools when there are none and sends all tool results of a turn in one user message', async () => {
    const { client, create } = fakeClient({ ...MESSAGE, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    await createAnthropicGateway({ client }).turn({ model: 'm', system: 's', messages: [{ role: 'user', text: 'x' }], tools: [], maxOutputTokens: 1024, effort: 'low' })
    expect(create.mock.calls[0]![0]).not.toHaveProperty('tools')

    expect(
      toAnthropicMessages([
        { role: 'user', text: 'q' },
        { role: 'assistant', content: MESSAGE.content },
        {
          role: 'tool_results',
          results: [
            { toolCallId: 'a', content: 'one', isError: false },
            { toolCallId: 'b', content: 'two', isError: true },
          ],
        },
      ]),
    ).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: MESSAGE.content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'one', is_error: false },
          { type: 'tool_result', tool_use_id: 'b', content: 'two', is_error: true },
        ],
      },
    ])
  })

  it('maps stop reasons', async () => {
    for (const [reason, expected] of [
      ['end_turn', 'end_turn'],
      ['stop_sequence', 'end_turn'],
      ['max_tokens', 'max_tokens'],
      ['model_context_window_exceeded', 'max_tokens'],
      ['refusal', 'refusal'],
      ['pause_turn', 'other'],
    ] as const) {
      const { client } = fakeClient({ ...MESSAGE, stop_reason: reason })
      const result = await createAnthropicGateway({ client }).turn({ model: 'm', system: 's', messages: [], tools: [], maxOutputTokens: 1024, effort: 'low' })
      expect(result.stopReason, reason).toBe(expected)
    }
  })

  it('returns validated structured output and reports refusals and cut-off answers', async () => {
    const schema = z.object({ name: z.string() })
    const ok = fakeClient({ ...MESSAGE, stop_reason: 'end_turn', parsed_output: { name: 'Sales Ops' } })
    const structured = await createAnthropicGateway({ client: ok.client }).structured({ model: 'm', system: 's', prompt: 'p', schema, maxOutputTokens: 4000, effort: 'medium' })
    expect(structured).toEqual({ value: { name: 'Sales Ops' }, model: 'claude-sonnet-5-5', usage: { inputTokens: 1200, outputTokens: 80 } })
    const [body] = ok.parse.mock.calls[0]! as unknown as [{ output_config: { effort: string; format: { type: string } } }]
    expect(body.output_config.effort).toBe('medium')
    expect(body.output_config.format.type).toBe('json_schema')

    const refused = fakeClient({ ...MESSAGE, stop_reason: 'refusal', parsed_output: null })
    await expect(createAnthropicGateway({ client: refused.client }).structured({ model: 'm', system: 's', prompt: 'p', schema, maxOutputTokens: 4000, effort: 'medium' })).rejects.toMatchObject({ code: 'refused' })
    const cut = fakeClient({ ...MESSAGE, stop_reason: 'max_tokens', parsed_output: null })
    await expect(createAnthropicGateway({ client: cut.client }).structured({ model: 'm', system: 's', prompt: 'p', schema, maxOutputTokens: 4000, effort: 'medium' })).rejects.toMatchObject({ code: 'invalid_output' })
  })

  it('maps SDK errors to gateway errors without the provider’s text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const headers = new Headers()
    expect(toModelError(new Anthropic.RateLimitError(429, {}, 'rate limited: key sk-ant-xyz', headers))).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(toModelError(new Anthropic.AuthenticationError(401, {}, 'bad key', headers))).toMatchObject({ code: 'auth', retryable: false })
    expect(toModelError(new Anthropic.BadRequestError(400, { error: { type: 'invalid_request_error' } }, 'nope', headers))).toMatchObject({ code: 'invalid_request' })
    expect(toModelError(new Anthropic.InternalServerError(529, {}, 'overloaded', headers))).toMatchObject({ code: 'overloaded', retryable: true })
    expect(toModelError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ code: 'timeout' })
    expect(toModelError(new Anthropic.APIConnectionError({ message: 'down' }))).toMatchObject({ code: 'unavailable' })
    expect(toModelError(new Anthropic.APIUserAbortError())).toMatchObject({ code: 'timeout' })
    expect(toModelError(new Anthropic.RateLimitError(429, {}, 'rate limited: key sk-ant-xyz', headers)).message).not.toContain('sk-ant')
    expect(() => toModelError(new TypeError('bug'))).toThrow('bug')
  })
})

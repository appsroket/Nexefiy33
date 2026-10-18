// Anthropic implementation of the model gateway, on the official SDK.
//
// Checked against the Claude API reference (2026-10-18): Claude Opus 5.5,
// Sonnet 5.5 and Haiku 5.5 think adaptively by default (the `thinking`
// parameter is omitted; depth is set with `output_config.effort`), reject
// non-default sampling parameters and forced `tool_choice`, and return
// `stop_reason: "refusal"` when a request is declined. So: no temperature, no
// forced tool choice (structured output uses `output_config.format`), and the
// assistant's full content (thinking blocks included) is sent back unchanged
// on the next turn. Server-side refusal fallbacks are not enabled: a refusal
// ends the run and is reported as such.

import 'server-only'

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

import { redact } from '@/lib/logging/redact'

import { ModelError, type ModelGateway, type ModelMessage, type ModelStopReason, type ModelTurnResult } from './gateway'

/** Per-request time limit; the runtime's own deadline is usually shorter. */
const REQUEST_TIMEOUT_MS = 120_000

export function toAnthropicMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.text }
      case 'assistant':
        return { role: 'assistant', content: message.content as Anthropic.ContentBlockParam[] }
      case 'tool_results':
        // All results of one turn go back in a single user message.
        return {
          role: 'user',
          content: message.results.map((result) => ({
            type: 'tool_result' as const,
            tool_use_id: result.toolCallId,
            content: result.content,
            is_error: result.isError,
          })),
        }
    }
  })
}

function stopReason(reason: Anthropic.StopReason | null): ModelStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

/** Maps SDK errors to gateway errors without copying provider text that might echo the request. */
export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error
  if (error instanceof Anthropic.APIUserAbortError) return new ModelError('timeout', 'The model request was stopped because the run reached its time limit.')
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ModelError('timeout', 'The model didn’t respond in time.', true)
  if (error instanceof Anthropic.APIConnectionError) return new ModelError('unavailable', 'The model provider couldn’t be reached.', true)
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ModelError('auth', 'The model provider rejected the API key. Check ANTHROPIC_API_KEY.')
  }
  if (error instanceof Anthropic.RateLimitError) return new ModelError('rate_limited', 'The model provider’s rate limit was reached. Try again shortly.', true)
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.UnprocessableEntityError || error instanceof Anthropic.NotFoundError) {
    console.error('[models] the provider rejected a request', redact({ status: error.status, type: (error.error as { error?: { type?: string } } | undefined)?.error?.type }))
    return new ModelError('invalid_request', 'The model provider rejected the request.')
  }
  if (error instanceof Anthropic.InternalServerError) {
    return error.status === 529
      ? new ModelError('overloaded', 'The model provider is overloaded. Try again shortly.', true)
      : new ModelError('unavailable', 'The model provider had an error. Try again shortly.', true)
  }
  if (error instanceof Anthropic.APIError) return new ModelError('unavailable', 'The model request failed.', true)
  throw error
}

export function createAnthropicGateway({ apiKey, client }: { apiKey?: string; client?: Anthropic }): ModelGateway {
  const anthropic = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: REQUEST_TIMEOUT_MS })

  return {
    provider: 'anthropic',

    async turn(request): Promise<ModelTurnResult> {
      let response: Anthropic.Message
      try {
        response = await anthropic.messages.create(
          {
            model: request.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: toAnthropicMessages(request.messages),
            ...(request.tools.length
              ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema as Anthropic.Tool.InputSchema })) }
              : {}),
            output_config: { effort: request.effort },
          },
          request.signal ? { signal: request.signal } : undefined,
        )
      } catch (error) {
        throw toModelError(error)
      }

      return {
        text: response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim(),
        toolCalls: response.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map((block) => ({ id: block.id, name: block.name, input: block.input })),
        stopReason: stopReason(response.stop_reason),
        model: response.model,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        assistantContent: response.content,
      }
    },

    async structured(request) {
      try {
        const response = await anthropic.messages.parse(
          {
            model: request.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.prompt }],
            output_config: { effort: request.effort, format: zodOutputFormat(request.schema) },
          },
          request.signal ? { signal: request.signal } : undefined,
        )
        if (response.stop_reason === 'refusal') throw new ModelError('refused', 'The model declined this request.')
        if (response.stop_reason === 'max_tokens') throw new ModelError('invalid_output', 'The model’s answer was cut off before it finished.')
        if (!response.parsed_output) throw new ModelError('invalid_output', 'The model’s answer didn’t match the expected format.')
        return {
          value: response.parsed_output,
          model: response.model,
          usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        }
      } catch (error) {
        if (error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError)) {
          // The SDK's own parsing/validation failure.
          throw new ModelError('invalid_output', 'The model’s answer didn’t match the expected format.')
        }
        throw toModelError(error)
      }
    },
  }
}

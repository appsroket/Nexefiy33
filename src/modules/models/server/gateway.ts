// The provider-neutral model interface the employee runtime uses (ADR-015).
// One implementation exists: Anthropic (./anthropic.ts). Requests carry tool
// definitions as JSON Schema; responses carry text, tool calls, a normalized
// stop reason and token usage.
//
// The assistant's raw content is passed back unchanged on the next turn
// (`assistantContent`), which providers need to continue a tool-use
// conversation (e.g. Claude's thinking blocks); the runtime never inspects it.

import 'server-only'

import type { ModelEffort } from '@/modules/employees/domain/types'

export interface ModelToolDefinition {
  /** Provider-safe name (letters, digits, "_" and "-"). */
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ModelToolResult {
  toolCallId: string
  content: string
  isError: boolean
}

export type ModelMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; content: unknown }
  | { role: 'tool_results'; results: ModelToolResult[] }

export interface ModelTurnRequest {
  model: string
  system: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  maxOutputTokens: number
  effort: ModelEffort
  signal?: AbortSignal
}

export interface ModelToolCall {
  id: string
  name: string
  input: unknown
}

export type ModelStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'

export interface ModelTurnResult {
  text: string
  toolCalls: ModelToolCall[]
  stopReason: ModelStopReason
  /** The model that actually served the request. */
  model: string
  usage: { inputTokens: number; outputTokens: number }
  assistantContent: unknown
}

export interface StructuredRequest<T> {
  model: string
  system: string
  prompt: string
  /** Validated with Zod after the provider returns. */
  schema: import('zod').ZodType<T>
  maxOutputTokens: number
  effort: ModelEffort
  signal?: AbortSignal
}

export interface StructuredResult<T> {
  value: T
  model: string
  usage: { inputTokens: number; outputTokens: number }
}

export const MODEL_ERROR_CODES = ['not_configured', 'invalid_request', 'auth', 'rate_limited', 'overloaded', 'timeout', 'unavailable', 'refused', 'invalid_output'] as const
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number]

export class ModelError extends Error {
  override name = 'ModelError'
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

export function isModelError(error: unknown): error is ModelError {
  return error instanceof ModelError
}

export interface ModelGateway {
  provider: 'anthropic'
  turn(request: ModelTurnRequest): Promise<ModelTurnResult>
  structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>
}

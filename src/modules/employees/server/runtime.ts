// The one employee runtime. Every employee, whatever its department, runs
// through this loop; only its configuration differs.
//
//   model turn → tool calls (each validated, authorized and limited by the
//   invoker) → results back to the model → … until it answers, escalates, is
//   refused, or hits a limit (turns, tool calls, time, per-task cost, monthly
//   budget).
//
// Tools are whatever the version grants and nothing more: a call to any other
// name is refused, never executed. What a tool call actually does is decided
// by the ToolInvoker: the test invoker (./test-invoker.ts) runs reads and
// describes writes; live work will use an invoker that requests actions
// through the integration executor with the employee as the actor.

import 'server-only'

import { maxOutputCostMicros, modelForTier, requestCostMicros, findModel } from '@/modules/models/domain/catalog'
import { isModelError, type ModelGateway, type ModelMessage, type ModelToolDefinition, type ModelToolResult } from '@/modules/models/server/gateway'

import { buildSystemPrompt, ESCALATE_INPUT_SCHEMA, ESCALATE_TOOL_NAME, escalateToolDescription } from '../domain/prompt'
import type { TraceToolCall } from '../domain/test-checks'
import type { EmployeeConfig, EmployeeToolGrant, RunOutcome } from '../domain/types'
import { resolveTool, toolKeyFromName, toolNameFor, type ResolvedTool } from './tools'

export interface ToolOutcome {
  decision: TraceToolCall['decision']
  executed: boolean
  /** Returned to the model. */
  content: string
  isError: boolean
}

export interface ToolInvoker {
  invoke(call: { grant: EmployeeToolGrant; tool: ResolvedTool; input: unknown; callId: string }): Promise<ToolOutcome>
}

export type TranscriptEntry =
  | { kind: 'request'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; toolKey: string; input: unknown; decision: ToolOutcome['decision']; executed: boolean; result: string; isError: boolean }
  | { kind: 'escalation'; reason: string; message: string }
  | { kind: 'stopped'; reason: string }

export interface RunRequest {
  employeeName: string
  organizationName: string | null
  instructions: string
  config: EmployeeConfig
  input: string
  businessContext: string | null
  /** What is left of the monthly budget, in micro-dollars. */
  budgetRemainingMicros: number
}

export interface RunDeps {
  gateway: ModelGateway
  invoker: ToolInvoker
  now?: () => number
}

export interface RunResult {
  outcome: RunOutcome
  reply: string
  transcript: TranscriptEntry[]
  toolCalls: TraceToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  costMicros: number
  model: string
  error?: { code: string; message: string }
}

const MAX_RESULT_CHARS = 8000
const MAX_TRANSCRIPT_CHARS = 2000

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function clipValue(value: unknown): unknown {
  const text = JSON.stringify(value ?? null)
  return text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS - 1)}…` : value
}

export async function runEmployee(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now
  const { config } = request
  const model = modelForTier(config.model.tier)
  const costLimitMicros = Math.round(config.limits.maxCostUsdPerTask * 1_000_000)
  const deadline = now() + config.limits.maxRuntimeSeconds * 1000

  const granted = config.tools.flatMap((grant) => {
    const tool = resolveTool(grant.toolKey)
    return tool ? [{ grant, tool }] : []
  })
  const definitions: ModelToolDefinition[] = [
    ...granted.map(({ tool }) => ({
      name: toolNameFor(tool.info.key),
      description: `${tool.info.title}. ${tool.info.description}`,
      inputSchema: tool.kind === 'built_in' ? tool.tool.inputJsonSchema : tool.action.inputJsonSchema,
    })),
    { name: ESCALATE_TOOL_NAME, description: escalateToolDescription(config.escalation.behavior), inputSchema: { ...ESCALATE_INPUT_SCHEMA } },
  ]
  const system = buildSystemPrompt({
    employeeName: request.employeeName,
    organizationName: request.organizationName,
    instructions: request.instructions,
    config,
    tools: granted.map(({ tool }) => tool.info),
    mode: 'test',
    businessContext: request.businessContext,
  })

  const transcript: TranscriptEntry[] = [{ kind: 'request', text: request.input }]
  const toolCalls: TraceToolCall[] = []
  const messages: ModelMessage[] = [{ role: 'user', text: request.input }]
  const usage = { inputTokens: 0, outputTokens: 0 }
  let costMicros = 0
  let servedModel = model.id
  let reply = ''

  const finish = (outcome: RunOutcome, extra: Partial<RunResult> = {}): RunResult => ({
    outcome,
    reply,
    transcript,
    toolCalls,
    usage,
    costMicros,
    model: servedModel,
    ...extra,
  })
  const stop = (reason: string): RunResult => {
    transcript.push({ kind: 'stopped', reason })
    return finish('limit_reached')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - now()))
  try {
    for (let turn = 1; turn <= config.limits.maxTurnsPerTask; turn += 1) {
      const worstCase = maxOutputCostMicros(model, config.model.maxOutputTokens)
      if (costMicros + worstCase > costLimitMicros) return stop('Stopped before the next step could exceed the per-task cost limit.')
      if (costMicros + worstCase > request.budgetRemainingMicros) return stop('Stopped: the next step could exceed this month’s budget.')
      if (now() >= deadline) return stop('Stopped: the run reached its time limit.')

      const result = await deps.gateway.turn({
        model: model.id,
        system,
        messages,
        tools: definitions,
        maxOutputTokens: config.model.maxOutputTokens,
        effort: config.model.effort,
        signal: controller.signal,
      })
      servedModel = result.model
      usage.inputTokens += result.usage.inputTokens
      usage.outputTokens += result.usage.outputTokens
      costMicros += requestCostMicros(findModel(result.model) ?? model, result.usage.inputTokens, result.usage.outputTokens)
      if (result.text) {
        transcript.push({ kind: 'assistant', text: result.text })
        reply = result.text
      }

      if (result.stopReason === 'refusal') {
        transcript.push({ kind: 'stopped', reason: 'The model declined this request.' })
        return finish('refused')
      }
      if (result.toolCalls.length === 0) {
        if (result.stopReason === 'max_tokens') return stop('The answer was cut off at the output limit; raise “Max output tokens” or simplify the request.')
        return finish('completed')
      }

      messages.push({ role: 'assistant', content: result.assistantContent })
      const results: ModelToolResult[] = []
      for (const call of result.toolCalls) {
        if (call.name === ESCALATE_TOOL_NAME) {
          const input = (call.input ?? {}) as { reason?: unknown; message?: unknown }
          const message = typeof input.message === 'string' ? clip(input.message, 4000) : 'The employee escalated without a message.'
          const reason = typeof input.reason === 'string' ? clip(input.reason, 300) : 'No reason given.'
          transcript.push({ kind: 'escalation', reason, message })
          reply = message
          return finish('escalated')
        }

        const key = toolKeyFromName(call.name)
        const entry = granted.find(({ grant }) => grant.toolKey === key)
        let outcome: ToolOutcome
        if (!entry) {
          outcome = { decision: 'refused', executed: false, isError: true, content: `“${call.name}” isn’t one of your tools.` }
        } else if (toolCalls.length >= config.limits.maxToolCallsPerTask) {
          outcome = { decision: 'refused', executed: false, isError: true, content: 'The tool call limit for this task was reached. Finish with what you have or escalate.' }
        } else {
          outcome = await deps.invoker.invoke({ grant: entry.grant, tool: entry.tool, input: call.input, callId: call.id })
        }
        if (entry) toolCalls.push({ toolKey: key, decision: outcome.decision })
        transcript.push({
          kind: 'tool_call',
          toolKey: key,
          input: clipValue(call.input),
          decision: outcome.decision,
          executed: outcome.executed,
          result: clip(outcome.content, MAX_TRANSCRIPT_CHARS),
          isError: outcome.isError,
        })
        results.push({ toolCallId: call.id, content: clip(outcome.content, MAX_RESULT_CHARS), isError: outcome.isError })
      }
      messages.push({ role: 'tool_results', results })
    }
    return stop(`Stopped after ${config.limits.maxTurnsPerTask} steps (the turn limit).`)
  } catch (error) {
    if (isModelError(error)) {
      transcript.push({ kind: 'stopped', reason: error.message })
      return finish('error', { error: { code: error.code, message: error.message } })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

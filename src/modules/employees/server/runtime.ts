// The one employee runtime. Every employee, whatever its department, runs
// through this loop; only its configuration differs. The test playground and
// live tasks use it alike: they differ in the tool invoker (test vs live) and
// in whether the run is persisted between steps.
//
//   model turn → tool calls (each validated, authorized and limited by the
//   invoker) → results back to the model (framed as untrusted data) → … until
//   it finishes (finish_task or a plain answer), escalates, is refused, waits
//   for an approval, is cancelled, or hits a limit (turns, tool calls, active
//   time, per-task cost, monthly budget).
//
// Tools are whatever the version grants and nothing more: a call to any other
// name is refused, never executed. What a tool call actually does is decided
// by the ToolInvoker: the test invoker (./test-invoker.ts) runs reads and
// describes writes; the live invoker (./live-invoker.ts) requests actions
// through the integration executor with the employee as the actor.
//
// State lives in a checkpoint (conversation, counters, the last turn's tool
// calls and their results). `hooks.checkpoint` is called after every model
// turn and every tool call; a run started from a checkpoint continues exactly
// where it stopped: calls that already have results aren't repeated, calls
// that were waiting for an approval are resolved through the invoker, and an
// escalation continues with the requester's reply. Limits count across all
// segments of a task (active time excludes waiting).

import 'server-only'

import { maxOutputCostMicros, modelForTier, requestCostMicros, findModel } from '@/modules/models/domain/catalog'
import { isModelError, type ModelGateway, type ModelMessage, type ModelToolDefinition, type ModelToolResult } from '@/modules/models/server/gateway'
import { MODEL_CALL_RETRIES, MODEL_RETRY_DELAYS_MS } from '@/modules/tasks/domain/failures'
import { frameToolResult, scrubSecrets } from '@/modules/tasks/domain/untrusted'
import type { TaskReport } from '@/modules/tasks/domain/verification'

import {
  buildSystemPrompt,
  ESCALATE_INPUT_SCHEMA,
  ESCALATE_TOOL_NAME,
  escalateToolDescription,
  FINISH_INPUT_SCHEMA,
  FINISH_TOOL_NAME,
  finishToolDescription,
} from '../domain/prompt'
import type { TraceToolCall } from '../domain/test-checks'
import type { EmployeeConfig, EmployeeToolGrant, RunOutcome } from '../domain/types'
import { resolveTool, toolKeyFromName, toolNameFor, type ResolvedTool } from './tools'

export interface EvidenceItem {
  kind: 'knowledge_passage' | 'tool_result'
  toolKey?: string
  executionId?: string
  sourceId?: string
  chunkId?: string
  label?: string
  title: string
  excerpt: string
  suspicious: boolean
}

export interface ToolOutcome {
  decision: TraceToolCall['decision']
  executed: boolean
  /** Returned to the model (framed and scrubbed by the runtime). */
  content: string
  isError: boolean
  /** The content came from outside Nexefiy (a provider response, a document) and is framed as untrusted data. */
  untrusted?: boolean
  /** The content was already found to contain instruction-like text. */
  suspicious?: boolean
  /** The tool execution recorded by the integration executor; its id is the receipt. */
  executionId?: string
  /** The action waits for approval (executionId is set); the run pauses after this turn. */
  waiting?: boolean
  evidence?: EvidenceItem[]
}

export interface ToolCallContext {
  /** The task has already received content that looks like instructions; writes must wait for approval. */
  suspiciousContentSeen: boolean
}

export interface ToolInvoker {
  invoke(call: { grant: EmployeeToolGrant; tool: ResolvedTool; input: unknown; callId: string; context?: ToolCallContext }): Promise<ToolOutcome>
  /** The result of an action that was waiting for approval, or null while it still waits. */
  resolve?(wait: { executionId: string; toolKey: string; callId: string }): Promise<ToolOutcome | null>
}

export type TranscriptEntry =
  | { kind: 'request'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; toolKey: string; input: unknown; decision: ToolOutcome['decision']; executed: boolean; result: string; isError: boolean; executionId?: string }
  | { kind: 'approval_result'; toolKey: string; executed: boolean; result: string; isError: boolean; executionId: string }
  | { kind: 'escalation'; reason: string; message: string }
  | { kind: 'reply'; text: string }
  | { kind: 'report'; status: TaskReport['status']; summary: string; receipts: string[] }
  | { kind: 'stopped'; reason: string }

type PendingWait = { kind: 'approval'; executionId: string; toolKey: string } | { kind: 'reply' }

export interface PendingCall {
  id: string
  name: string
  input: unknown
  result?: ModelToolResult
  wait?: PendingWait
}

export interface RunCheckpoint {
  version: 1
  messages: ModelMessage[]
  /** Tool calls of the last assistant turn, until all have results. */
  pending: PendingCall[] | null
  turns: number
  toolCalls: TraceToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  costMicros: number
  activeMs: number
  model: string
  lastText: string
  report: TaskReport | null
  suspiciousContentSeen: boolean
  transcript: TranscriptEntry[]
  /** Written by reply_to_employee_task when a person answers an escalation. */
  requesterReply?: { text: string }
}

export type TaskRunOutcome = RunOutcome | 'waiting_approval' | 'cancelled'

export type RunEvent =
  | { type: 'model_turn'; turn: number; model: string; inputTokens: number; outputTokens: number; costMicros: number; stopReason: string; durationMs: number }
  | { type: 'model_retry'; code: string; retry: number; delayMs: number }
  | { type: 'tool_call'; turn: number; toolKey: string; decision: ToolOutcome['decision']; executed: boolean; isError: boolean; executionId?: string; suspicious: boolean; evidence: EvidenceItem[] }
  | { type: 'approval_result'; toolKey: string; executionId: string; executed: boolean; isError: boolean; evidence: EvidenceItem[] }

export interface RunHooks {
  /** Persists the state; a run started from it continues where this one stopped. Throwing stops the run. */
  checkpoint?(state: RunCheckpoint): Promise<void>
  event?(event: RunEvent): Promise<void> | void
  /** Checked before every model turn; true ends the run as "cancelled". */
  shouldStop?(): Promise<boolean>
}

export interface RunRequest {
  employeeName: string
  organizationName: string | null
  instructions: string
  config: EmployeeConfig
  /** The first user message (the task, with any context assembled for it). Ignored when continuing. */
  input: string
  businessContext: string | null
  /** What is left of the monthly budget, in micro-dollars (spend of earlier segments already deducted). */
  budgetRemainingMicros: number
  mode?: 'test' | 'live'
  checkpoint?: RunCheckpoint | null
}

export interface RunDeps {
  gateway: ModelGateway
  invoker: ToolInvoker
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  hooks?: RunHooks
}

export interface RunResult {
  outcome: TaskRunOutcome
  reply: string
  report: TaskReport | null
  transcript: TranscriptEntry[]
  toolCalls: TraceToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  costMicros: number
  model: string
  checkpoint: RunCheckpoint
  error?: { code: string; message: string; retryable: boolean }
}

const MAX_RESULT_CHARS = 8000
const MAX_TRANSCRIPT_CHARS = 2000
const REPORT_STATUSES = ['completed', 'partially_completed', 'not_completed'] as const

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function clipValue(value: unknown): unknown {
  const text = scrubSecrets(JSON.stringify(value ?? null))
  return text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS - 1)}…` : JSON.parse(text)
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function freshCheckpoint(input: string, model: string): RunCheckpoint {
  return {
    version: 1,
    messages: [{ role: 'user', text: input }],
    pending: null,
    turns: 0,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    costMicros: 0,
    activeMs: 0,
    model,
    lastText: '',
    report: null,
    suspiciousContentSeen: false,
    transcript: [{ kind: 'request', text: input }],
  }
}

function parseReport(input: unknown): TaskReport | string {
  const value = (input ?? {}) as { status?: unknown; summary?: unknown; receipts?: unknown }
  if (typeof value.status !== 'string' || !(REPORT_STATUSES as readonly string[]).includes(value.status)) return 'status must be completed, partially_completed or not_completed'
  if (typeof value.summary !== 'string' || !value.summary.trim()) return 'summary is required'
  if (!Array.isArray(value.receipts) || value.receipts.some((receipt) => typeof receipt !== 'string')) return 'receipts must be a list of receipts'
  return {
    status: value.status as TaskReport['status'],
    summary: clip(scrubSecrets(value.summary.trim()), 4000),
    receipts: [...new Set((value.receipts as string[]).map((receipt) => receipt.trim()).filter(Boolean))].slice(0, 50),
  }
}

export async function runEmployee(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const hooks = deps.hooks ?? {}
  const { config } = request
  const model = modelForTier(config.model.tier)
  const costLimitMicros = Math.round(config.limits.maxCostUsdPerTask * 1_000_000)

  const state: RunCheckpoint = request.checkpoint ? structuredClone(request.checkpoint) : freshCheckpoint(request.input, model.id)
  const start = now()
  const priorActiveMs = state.activeMs
  const segmentCostStart = state.costMicros
  const deadline = start + config.limits.maxRuntimeSeconds * 1000 - priorActiveMs
  const transcript = state.transcript

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
    { name: FINISH_TOOL_NAME, description: finishToolDescription(), inputSchema: structuredClone(FINISH_INPUT_SCHEMA) as unknown as Record<string, unknown> },
  ]
  const system = buildSystemPrompt({
    employeeName: request.employeeName,
    organizationName: request.organizationName,
    instructions: request.instructions,
    config,
    tools: granted.map(({ tool }) => tool.info),
    mode: request.mode ?? 'test',
    businessContext: request.businessContext,
  })

  const save = async () => {
    state.activeMs = priorActiveMs + (now() - start)
    await hooks.checkpoint?.(state)
  }
  const finish = (outcome: TaskRunOutcome, extra: Partial<RunResult> = {}): RunResult => {
    state.activeMs = priorActiveMs + (now() - start)
    return {
      outcome,
      reply: state.report?.summary ?? state.lastText,
      report: state.report,
      transcript,
      toolCalls: state.toolCalls,
      usage: state.usage,
      costMicros: state.costMicros,
      model: state.model,
      checkpoint: state,
      ...extra,
    }
  }
  const stop = (reason: string): RunResult => {
    transcript.push({ kind: 'stopped', reason })
    return finish('limit_reached')
  }

  /** Records a tool call's result for the model, the transcript and the trace. */
  const applyOutcome = async (call: PendingCall, key: string, outcome: ToolOutcome, resolvedFrom?: string) => {
    const framed = frameToolResult(key, outcome.content, { trusted: !outcome.untrusted })
    if (framed.suspicious || outcome.suspicious) state.suspiciousContentSeen = true
    call.result = { toolCallId: call.id, content: clip(framed.content, MAX_RESULT_CHARS), isError: outcome.isError }
    delete call.wait
    const shown = clip(scrubSecrets(outcome.content), MAX_TRANSCRIPT_CHARS)
    const evidence = outcome.evidence ?? []
    if (resolvedFrom) {
      transcript.push({ kind: 'approval_result', toolKey: key, executed: outcome.executed, result: shown, isError: outcome.isError, executionId: resolvedFrom })
      await hooks.event?.({ type: 'approval_result', toolKey: key, executionId: resolvedFrom, executed: outcome.executed, isError: outcome.isError, evidence })
      return
    }
    transcript.push({
      kind: 'tool_call',
      toolKey: key,
      input: clipValue(call.input),
      decision: outcome.decision,
      executed: outcome.executed,
      result: shown,
      isError: outcome.isError,
      ...(outcome.executionId ? { executionId: outcome.executionId } : {}),
    })
    await hooks.event?.({
      type: 'tool_call',
      turn: state.turns,
      toolKey: key,
      decision: outcome.decision,
      executed: outcome.executed,
      isError: outcome.isError,
      ...(outcome.executionId ? { executionId: outcome.executionId } : {}),
      suspicious: framed.suspicious || Boolean(outcome.suspicious),
      evidence,
    })
  }

  /**
   * Gives every call of the last turn a result, or leaves it waiting.
   * "done": all have results (sent back to the model); "finished": the
   * employee filed its report; otherwise the run pauses.
   */
  const settlePending = async (): Promise<'done' | 'finished' | 'waiting_approval' | 'escalated'> => {
    const pending = state.pending ?? []
    let escalated = false
    let report: TaskReport | null = null

    for (const call of pending) {
      if (call.result) continue
      const key = toolKeyFromName(call.name)

      if (call.wait?.kind === 'reply') {
        const reply = state.requesterReply?.text
        if (!reply) {
          escalated = true
          continue
        }
        const text = clip(scrubSecrets(reply), 4000)
        call.result = { toolCallId: call.id, content: `The requester replied: ${text}`, isError: false }
        delete call.wait
        delete state.requesterReply
        transcript.push({ kind: 'reply', text })
        await save()
        continue
      }
      if (call.wait?.kind === 'approval') {
        const resolved = deps.invoker.resolve ? await deps.invoker.resolve({ ...call.wait, callId: call.id }) : null
        if (resolved) {
          await applyOutcome(call, key, resolved, call.wait.executionId)
          await save()
        }
        continue
      }

      if (escalated || report) {
        call.result = { toolCallId: call.id, content: 'Not run: you already escalated or finished in this step.', isError: true }
        continue
      }

      if (call.name === ESCALATE_TOOL_NAME) {
        const input = (call.input ?? {}) as { reason?: unknown; message?: unknown }
        const message = typeof input.message === 'string' ? clip(scrubSecrets(input.message), 4000) : 'The employee escalated without a message.'
        const reason = typeof input.reason === 'string' ? clip(scrubSecrets(input.reason), 300) : 'No reason given.'
        transcript.push({ kind: 'escalation', reason, message })
        state.lastText = message
        call.wait = { kind: 'reply' }
        escalated = true
        continue
      }

      if (call.name === FINISH_TOOL_NAME) {
        if (pending.some((other) => other.wait?.kind === 'approval')) {
          call.result = { toolCallId: call.id, content: 'Not finished: an action from this step is waiting for approval. You will get its result first.', isError: true }
          continue
        }
        const parsed = parseReport(call.input)
        if (typeof parsed === 'string') {
          call.result = { toolCallId: call.id, content: `Invalid report: ${parsed}.`, isError: true }
          continue
        }
        report = parsed
        call.result = { toolCallId: call.id, content: 'Report received.', isError: false }
        transcript.push({ kind: 'report', ...parsed })
        continue
      }

      const entry = granted.find(({ grant }) => grant.toolKey === key)
      let outcome: ToolOutcome
      if (!entry) {
        outcome = { decision: 'refused', executed: false, isError: true, content: `“${call.name}” isn’t one of your tools.` }
      } else if (state.toolCalls.length >= config.limits.maxToolCallsPerTask) {
        outcome = { decision: 'refused', executed: false, isError: true, content: 'The tool call limit for this task was reached. Finish with what you have or escalate.' }
      } else {
        outcome = await deps.invoker.invoke({
          grant: entry.grant,
          tool: entry.tool,
          input: call.input,
          callId: call.id,
          context: { suspiciousContentSeen: state.suspiciousContentSeen },
        })
      }
      if (entry) state.toolCalls.push({ toolKey: key, decision: outcome.decision })

      if (outcome.waiting && outcome.executionId) {
        call.wait = { kind: 'approval', executionId: outcome.executionId, toolKey: key }
        transcript.push({
          kind: 'tool_call',
          toolKey: key,
          input: clipValue(call.input),
          decision: 'require_approval',
          executed: false,
          result: clip(scrubSecrets(outcome.content), MAX_TRANSCRIPT_CHARS),
          isError: false,
          executionId: outcome.executionId,
        })
        await hooks.event?.({ type: 'tool_call', turn: state.turns, toolKey: key, decision: 'require_approval', executed: false, isError: false, executionId: outcome.executionId, suspicious: false, evidence: [] })
      } else {
        await applyOutcome(call, key, outcome)
      }
      await save()
    }

    if (pending.some((call) => call.wait?.kind === 'approval')) return 'waiting_approval'
    if (escalated) return 'escalated'
    if (report) {
      state.report = report
      state.lastText = report.summary
      state.pending = null
      await save()
      return 'finished'
    }
    state.messages.push({ role: 'tool_results', results: pending.map((call) => call.result!) })
    state.pending = null
    await save()
    return 'done'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - now()))

  const callModel = async () => {
    for (let retry = 0; ; retry += 1) {
      try {
        return await deps.gateway.turn({
          model: model.id,
          system,
          messages: state.messages,
          tools: definitions,
          maxOutputTokens: config.model.maxOutputTokens,
          effort: config.model.effort,
          signal: controller.signal,
        })
      } catch (error) {
        const delayMs = MODEL_RETRY_DELAYS_MS[retry] ?? 0
        if (isModelError(error) && error.retryable && !controller.signal.aborted && retry < MODEL_CALL_RETRIES && now() + delayMs < deadline) {
          await hooks.event?.({ type: 'model_retry', code: error.code, retry: retry + 1, delayMs })
          await sleep(delayMs)
          continue
        }
        throw error
      }
    }
  }

  try {
    if (state.pending) {
      const settled = await settlePending()
      if (settled === 'waiting_approval' || settled === 'escalated') return finish(settled)
      if (settled === 'finished') return finish('completed')
    }

    for (;;) {
      if (await hooks.shouldStop?.()) {
        transcript.push({ kind: 'stopped', reason: 'The task was cancelled.' })
        await save()
        return finish('cancelled')
      }
      if (state.turns >= config.limits.maxTurnsPerTask) return stop(`Stopped after ${config.limits.maxTurnsPerTask} steps (the turn limit).`)
      const worstCase = maxOutputCostMicros(model, config.model.maxOutputTokens)
      if (state.costMicros + worstCase > costLimitMicros) return stop('Stopped before the next step could exceed the per-task cost limit.')
      if (state.costMicros - segmentCostStart + worstCase > request.budgetRemainingMicros) return stop('Stopped: the next step could exceed this month’s budget.')
      if (now() >= deadline) return stop('Stopped: the run reached its time limit.')

      const turnStart = now()
      const result = await callModel()
      const turnCost = requestCostMicros(findModel(result.model) ?? model, result.usage.inputTokens, result.usage.outputTokens)
      state.turns += 1
      state.model = result.model
      state.usage.inputTokens += result.usage.inputTokens
      state.usage.outputTokens += result.usage.outputTokens
      state.costMicros += turnCost
      await hooks.event?.({
        type: 'model_turn',
        turn: state.turns,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costMicros: turnCost,
        stopReason: result.stopReason,
        durationMs: now() - turnStart,
      })
      if (result.text) {
        const text = scrubSecrets(result.text)
        transcript.push({ kind: 'assistant', text })
        state.lastText = text
      }

      if (result.stopReason === 'refusal') {
        transcript.push({ kind: 'stopped', reason: 'The model declined this request.' })
        await save()
        return finish('refused')
      }
      if (result.toolCalls.length === 0) {
        if (result.stopReason === 'max_tokens') return stop('The answer was cut off at the output limit; raise “Max output tokens” or simplify the request.')
        await save()
        return finish('completed')
      }

      state.messages.push({ role: 'assistant', content: result.assistantContent })
      state.pending = result.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input }))
      await save()
      const settled = await settlePending()
      if (settled === 'waiting_approval' || settled === 'escalated') return finish(settled)
      if (settled === 'finished') return finish('completed')
    }
  } catch (error) {
    if (isModelError(error)) {
      if (controller.signal.aborted) return stop('Stopped: the run reached its time limit.')
      transcript.push({ kind: 'stopped', reason: error.message })
      return finish('error', { error: { code: error.code, message: error.message, retryable: error.retryable } })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

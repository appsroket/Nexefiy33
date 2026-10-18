// How tool calls behave when an active employee works on a task.
//
// Every call is validated against the tool's schema here, then:
//   - knowledge search runs against the organization's knowledge (the
//     organization comes from the task, never from the model), restricted to
//     the sources the version allows; passages are returned as framed
//     evidence;
//   - integration actions go through the integration executor with the
//     employee as the actor. The executor repeats every check (connection,
//     scopes, the grant written at activation, the action setting, workspace
//     policy), records the execution under an idempotency key derived from the
//     task and the model's call id (so a resumed or retried step never runs an
//     action twice), and runs it, asks for approval, or refuses.
//
// The employee's approval rule is passed as a floor (it can only add
// approval), and once the task has read instruction-like content every write
// waits for approval. A result says an action happened only when the executor
// recorded it as succeeded; its execution id is the receipt the employee must
// cite, and the task's verification re-reads it from the database.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import type { AdminClient } from '@/lib/supabase/admin'
import { requestAction, type EmployeeActor, type ExecuteResult } from '@/modules/integrations/server/executor'
import type { IntegrationRuntime } from '@/modules/integrations/server/runtime'
import { formatEvidenceForModel, type EvidenceResult } from '@/modules/knowledge/domain/evidence'
import type { Embedder } from '@/modules/knowledge/server/embeddings'
import { retrieveKnowledge } from '@/modules/knowledge/server/retrieval'

import type { EmployeeConfig } from '../domain/types'
import type { EvidenceItem, ToolInvoker, ToolOutcome } from './runtime'
import { resolveTool } from './tools'

export interface LiveInvokerOptions {
  organizationId: string
  actor: EmployeeActor
  knowledge: EmployeeConfig['knowledge']
  admin: AdminClient
  embedder: Embedder | null
  /** Null when integrations aren't configured on this deployment. */
  integrations: IntegrationRuntime | null
}

const MAX_OUTPUT_CHARS = 6000

function issuesText(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`).join('; ')
}

export function knowledgeEvidence(evidence: EvidenceResult): EvidenceItem[] {
  return evidence.passages.map((passage) => ({
    kind: 'knowledge_passage',
    sourceId: passage.sourceId,
    chunkId: passage.chunkId,
    label: passage.citation.label,
    title: passage.citation.location ? `${passage.citation.sourceName} (${passage.citation.location})` : passage.citation.sourceName,
    excerpt: passage.content.slice(0, 2000),
    suspicious: Boolean(passage.metadata.suspectedInstructions),
  }))
}

function outputText(output: unknown): string {
  const text = JSON.stringify(output ?? null)
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS - 1)}…` : text
}

function succeeded(toolKey: string, title: string, executionId: string, output: unknown, note = ''): ToolOutcome {
  const text = outputText(output)
  return {
    decision: 'allow',
    executed: true,
    isError: false,
    untrusted: true,
    executionId,
    content: `Succeeded${note}. Receipt: ${executionId}\nResult: ${text}`,
    evidence: [{ kind: 'tool_result', toolKey, executionId, label: executionId, title, excerpt: text.slice(0, 2000), suspicious: false }],
  }
}

/** Maps what the executor recorded to what the model is told. Nothing here infers success. */
function fromExecutorResult(toolKey: string, title: string, result: ExecuteResult): ToolOutcome {
  switch (result.status) {
    case 'succeeded':
      return succeeded(toolKey, title, result.executionId, result.output)
    case 'awaiting_approval':
      return {
        decision: 'require_approval',
        executed: false,
        isError: false,
        waiting: true,
        executionId: result.executionId,
        content: 'This action is waiting for a person’s approval. It has not happened yet; you will receive its result when it is decided.',
      }
    case 'denied':
      return { decision: 'deny', executed: false, isError: false, executionId: result.executionId, content: `Blocked: ${result.reason} The action was not run; don’t try another way.` }
    case 'failed':
      return {
        decision: 'allow',
        executed: false,
        isError: true,
        executionId: result.executionId,
        content:
          result.error.code === 'outcome_unknown'
            ? `${title}: it is unknown whether this happened (${result.error.message}). Do not retry it; tell the requester to check.`
            : `${title} failed (${result.error.code}): ${result.error.message} Nothing was changed by this call.`,
      }
    case 'refused':
      return { decision: 'refused', executed: false, isError: true, content: result.error.message }
    case 'invalid_input':
      return { decision: 'refused', executed: false, isError: true, content: `Invalid input: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}` }
    case 'duplicate':
      // The same call was already recorded (a resumed or retried step).
      if (result.executionStatus === 'succeeded') return succeeded(toolKey, title, result.executionId, result.output, ' (recorded earlier)')
      if (['proposed', 'awaiting_approval', 'approved', 'executing'].includes(result.executionStatus)) {
        return { decision: 'require_approval', executed: false, isError: false, waiting: true, executionId: result.executionId, content: 'This action is still pending; it has not happened yet.' }
      }
      return statusOutcome(toolKey, title, result.executionId, result.executionStatus, null, null)
  }
}

/** The outcome of an execution that has finished, from its stored status. */
function statusOutcome(toolKey: string, title: string, executionId: string, status: string, output: unknown, error: { code?: string; message?: string } | null): ToolOutcome {
  switch (status) {
    case 'succeeded':
      return succeeded(toolKey, title, executionId, output, ' after approval')
    case 'rejected':
      return { decision: 'require_approval', executed: false, isError: false, executionId, content: 'A person rejected this action. It did not happen. Don’t try another way; tell the requester.' }
    case 'cancelled':
      return { decision: 'require_approval', executed: false, isError: false, executionId, content: 'This action was cancelled (its approval expired or was withdrawn). It did not happen.' }
    case 'skipped':
      return { decision: 'deny', executed: false, isError: false, executionId, content: 'This action was blocked by policy. It did not happen.' }
    default:
      return {
        decision: 'allow',
        executed: false,
        isError: true,
        executionId,
        content:
          error?.code === 'outcome_unknown'
            ? `${title}: it is unknown whether this happened. Do not retry it; tell the requester to check.`
            : `${title} failed${error?.code ? ` (${error.code})` : ''}: ${error?.message ?? 'no details'}. Nothing was changed by this call.`,
      }
  }
}

export function createLiveToolInvoker(options: LiveInvokerOptions): ToolInvoker {
  const { organizationId, actor } = options
  return {
    async invoke({ grant, tool, input, callId, context }): Promise<ToolOutcome> {
      const schema = tool.kind === 'built_in' ? tool.tool.input : tool.action.input
      const parsed = schema.safeParse(input)
      if (!parsed.success) {
        return { decision: 'refused', executed: false, isError: true, content: `Invalid input for ${tool.info.title}: ${issuesText(parsed.error.issues)}` }
      }

      if (tool.kind === 'built_in') {
        if (options.knowledge.access === 'none') {
          return { decision: 'refused', executed: false, isError: true, content: 'Knowledge access is turned off for this employee.' }
        }
        try {
          const evidence = await retrieveKnowledge(options.admin, {
            organizationId,
            query: (parsed.data as { query: string }).query,
            ...(options.knowledge.access === 'selected' ? { sourceIds: options.knowledge.sourceIds } : {}),
            limit: options.knowledge.maxPassages,
            embedder: options.embedder,
          })
          const items = knowledgeEvidence(evidence)
          return {
            decision: 'allow',
            executed: true,
            isError: false,
            content: formatEvidenceForModel(evidence),
            suspicious: items.some((item) => item.suspicious),
            evidence: items,
          }
        } catch (error) {
          console.error('[employees] knowledge search failed in a task', redact(error))
          return { decision: 'allow', executed: false, isError: true, content: 'Knowledge search is unavailable right now.' }
        }
      }

      if (!grant.integrationId) {
        return { decision: 'refused', executed: false, isError: true, content: `No ${tool.info.providerName} connection is chosen for this tool.` }
      }
      if (!options.integrations) {
        return { decision: 'refused', executed: false, isError: true, content: 'Integrations aren’t configured on this deployment.' }
      }

      const floor = context?.suspiciousContentSeen && tool.info.risk !== 'read' ? 'require_approval' : grant.approval
      const result = await requestAction(options.integrations, {
        organizationId,
        integrationId: grant.integrationId,
        actionKey: tool.action.key,
        input: parsed.data,
        idempotencyKey: `task:${actor.taskId}:${callId}`.slice(0, 200),
        actor,
        approvalFloor: floor,
      })
      return fromExecutorResult(tool.action.key, tool.info.title, result)
    },

    async resolve({ executionId, toolKey }): Promise<ToolOutcome | null> {
      const { data, error } = await options.admin
        .from('tool_executions')
        .select('id, status, output_redacted, error, task_id')
        .eq('id', executionId)
        .eq('organization_id', organizationId)
        .eq('task_id', actor.taskId)
        .maybeSingle()
      if (error) throw new Error('The action’s status couldn’t be loaded.')
      if (!data) return { decision: 'refused', executed: false, isError: true, content: 'The action record no longer exists.' }
      if (['proposed', 'awaiting_approval', 'approved', 'executing'].includes(data.status)) return null
      return statusOutcome(toolKey, resolveTool(toolKey)?.info.title ?? toolKey, data.id, data.status, data.output_redacted, (data.error ?? null) as { code?: string; message?: string } | null)
    },
  }
}

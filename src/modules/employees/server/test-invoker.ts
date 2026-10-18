// How tool calls behave in the test playground.
//
// Every call is validated against the tool's schema and checked against the
// employee's grant, the connection (organization, status, scopes), the
// connection's action setting and workspace policies, exactly as live work
// would be. Then:
//   - knowledge search runs for real (internal, read-only);
//   - an integration read that would run without approval runs for real,
//     through requestAction with the tester as the actor (so it is recorded
//     like any other action);
//   - anything that changes data or sends something is NOT run: the result
//     says whether it would run, wait for approval, or be blocked.
// Nothing here pretends an action happened.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import type { AdminClient } from '@/lib/supabase/admin'
import { mostRestrictive } from '@/modules/integrations/domain/policy'
import { previewActionDecision, requestAction, type UserActor } from '@/modules/integrations/server/executor'
import type { IntegrationRuntime } from '@/modules/integrations/server/runtime'
import { formatEvidenceForModel } from '@/modules/knowledge/domain/evidence'
import type { Embedder } from '@/modules/knowledge/server/embeddings'
import { retrieveKnowledge } from '@/modules/knowledge/server/retrieval'

import type { EmployeeConfig } from '../domain/types'
import type { ToolInvoker, ToolOutcome } from './runtime'

export interface TestInvokerOptions {
  organizationId: string
  employeeId: string
  runId: string
  actor: UserActor
  knowledge: EmployeeConfig['knowledge']
  admin: AdminClient
  embedder: Embedder | null
  /** Null when integrations aren't configured on this deployment. */
  integrations: IntegrationRuntime | null
}

function issuesText(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`).join('; ')
}

export function createTestToolInvoker(options: TestInvokerOptions): ToolInvoker {
  return {
    async invoke({ grant, tool, input, callId }): Promise<ToolOutcome> {
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
            organizationId: options.organizationId,
            query: (parsed.data as { query: string }).query,
            ...(options.knowledge.access === 'selected' ? { sourceIds: options.knowledge.sourceIds } : {}),
            limit: options.knowledge.maxPassages,
            embedder: options.embedder,
          })
          return { decision: 'allow', executed: true, isError: false, content: formatEvidenceForModel(evidence) }
        } catch (error) {
          console.error('[employees] knowledge search failed in a test run', redact(error))
          return { decision: 'allow', executed: false, isError: true, content: 'Knowledge search is unavailable right now.' }
        }
      }

      if (!grant.integrationId) {
        return { decision: 'refused', executed: false, isError: true, content: `No ${tool.info.providerName} connection is chosen for this tool.` }
      }
      if (!options.integrations) {
        return { decision: 'refused', executed: false, isError: true, content: 'Integrations aren’t configured on this deployment.' }
      }

      const preview = await previewActionDecision(options.integrations, {
        organizationId: options.organizationId,
        integrationId: grant.integrationId,
        actionKey: tool.action.key,
        employeeId: options.employeeId,
      })
      if (preview.status === 'refused') return { decision: 'refused', executed: false, isError: true, content: preview.error.message }

      // The employee's own rule can add approval, never remove it.
      const decision = mostRestrictive(grant.approval, preview.decision)
      const proposed = JSON.stringify(parsed.data)
      if (decision === 'deny') {
        return { decision, executed: false, isError: false, content: `Blocked: ${preview.reason} The action was not run.` }
      }
      if (decision === 'require_approval') {
        return {
          decision,
          executed: false,
          isError: false,
          content: `Test run: not carried out. In live work this action would wait for approval before running. Proposed input: ${proposed}. Tell the requester it needs approval.`,
        }
      }
      if (tool.info.risk !== 'read') {
        return {
          decision,
          executed: false,
          isError: false,
          content: `Test run: not carried out. In live work this action would run without approval. Proposed input: ${proposed}.`,
        }
      }

      const result = await requestAction(options.integrations, {
        organizationId: options.organizationId,
        integrationId: grant.integrationId,
        actionKey: tool.action.key,
        input: parsed.data,
        idempotencyKey: `employee-test:${options.runId}:${callId}`.slice(0, 200),
        actor: options.actor,
      })
      switch (result.status) {
        case 'succeeded':
        case 'duplicate':
          return { decision: 'allow', executed: true, isError: false, content: JSON.stringify(result.output ?? null) }
        case 'failed':
          return { decision: 'allow', executed: true, isError: true, content: `${tool.info.title} failed: ${result.error.message}` }
        case 'refused':
          return { decision: 'refused', executed: false, isError: true, content: result.error.message }
        case 'invalid_input':
          return { decision: 'refused', executed: false, isError: true, content: `Invalid input: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}` }
        case 'awaiting_approval':
          return { decision: 'require_approval', executed: false, isError: false, content: 'This read now needs approval; it was not run.' }
        case 'denied':
          return { decision: 'deny', executed: false, isError: false, content: `Blocked: ${result.reason}` }
      }
    },
  }
}

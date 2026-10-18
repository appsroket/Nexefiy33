// Context assembly for a task's first step: what the employee is told, in
// order of trust.
//
//   system prompt   platform rules, then the employee's configuration, then
//                   the organization's business context (runtime.ts/prompt.ts)
//   first message   the task as the requester wrote it (an operator of the
//                   organization: instructions, bounded by the platform rules),
//                   then knowledge retrieved for it, framed as untrusted data
//
// The organization comes from the task row, never from the text. Retrieval
// here is a convenience (the employee can search again with its tool); it is
// limited to the sources the version allows and skipped when knowledge is off
// or nothing relevant is found.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import type { AdminClient } from '@/lib/supabase/admin'
import type { EmployeeConfig } from '@/modules/employees/domain/types'
import { knowledgeEvidence } from '@/modules/employees/server/live-invoker'
import type { EvidenceItem } from '@/modules/employees/server/runtime'
import { formatBusinessContextForModel } from '@/modules/knowledge/domain/business-context'
import { formatEvidenceForModel } from '@/modules/knowledge/domain/evidence'
import type { Embedder } from '@/modules/knowledge/server/embeddings'
import { getBusinessContext } from '@/modules/knowledge/server/queries'
import { retrieveKnowledge } from '@/modules/knowledge/server/retrieval'

export interface TaskContextInput {
  organizationId: string
  organizationName: string | null
  title: string
  instructions: string | null
  knowledge: EmployeeConfig['knowledge']
  /** Retrieve knowledge for the first message (only on a task's first step). */
  prefetch: boolean
}

export interface AssembledContext {
  input: string
  businessContext: string | null
  evidence: EvidenceItem[]
  suspicious: boolean
}

export function taskMessage(title: string, instructions: string | null, knowledgeBlock: string | null): string {
  return [
    `Task: ${title}`,
    ...(instructions ? ['', 'Details from the requester:', instructions] : []),
    ...(knowledgeBlock ? ['', 'Knowledge retrieved for this task:', knowledgeBlock] : []),
    '',
    'Work within your tools and limits. When you are done, call finish_task.',
  ].join('\n')
}

export async function assembleTaskContext(
  admin: AdminClient,
  embedder: Embedder | null,
  input: TaskContextInput,
  now: Date,
): Promise<AssembledContext> {
  let businessContext: string | null = null
  try {
    businessContext = formatBusinessContextForModel(await getBusinessContext(admin, input.organizationId, input.organizationName ?? ''), now)
  } catch (error) {
    console.error('[tasks] loading business context failed; continuing without it', redact(error))
  }

  let knowledgeBlock: string | null = null
  let evidence: EvidenceItem[] = []
  if (input.prefetch && input.knowledge.access !== 'none') {
    try {
      const result = await retrieveKnowledge(admin, {
        organizationId: input.organizationId,
        query: `${input.title}\n${input.instructions ?? ''}`.slice(0, 1000),
        ...(input.knowledge.access === 'selected' ? { sourceIds: input.knowledge.sourceIds } : {}),
        limit: input.knowledge.maxPassages,
        embedder,
      })
      if (result.verdict.sufficient && result.passages.length) {
        knowledgeBlock = formatEvidenceForModel(result)
        evidence = knowledgeEvidence(result)
      }
    } catch (error) {
      console.error('[tasks] retrieving knowledge for a task failed; continuing without it', redact(error))
    }
  }

  return {
    input: taskMessage(input.title, input.instructions, knowledgeBlock),
    businessContext,
    evidence,
    suspicious: evidence.some((item) => item.suspicious),
  }
}

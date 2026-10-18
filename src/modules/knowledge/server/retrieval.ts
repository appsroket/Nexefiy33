// Knowledge retrieval: hybrid (keyword + vector) search over an
// organization's ready sources, returned as cited evidence with a
// sufficiency verdict.
//
// The organization always comes from the caller's verified context (the
// member's active workspace, or the task an employee is running) — never from
// model output or request text. With a user client RLS also limits rows to the
// caller's organizations; with the privileged client the explicit
// organization filter inside search_knowledge is what confines results, and a
// pgTAP test covers it.

import 'server-only'

import { z } from 'zod'

import { redact } from '@/lib/logging/redact'
import type { Database } from '@/lib/supabase/types'
import type { SupabaseClient } from '@supabase/supabase-js'

import { assessEvidence, withCitations, type EvidenceResult, type RetrievedPassage } from '../domain/evidence'
import { toVectorLiteral, type Embedder } from './embeddings'

export const DEFAULT_MATCH_COUNT = 6
/** With weak evidence, show at most this many "closest" passages. */
const WEAK_MATCH_LIMIT = 3

export class RetrievalError extends Error {
  override name = 'RetrievalError'
}

const metadataSchema = z
  .object({
    pageStart: z.number().int().positive().optional(),
    pageEnd: z.number().int().positive().optional(),
    headingPath: z.array(z.string()).optional(),
    suspectedInstructions: z.boolean().optional(),
  })
  .catch({})

export async function retrieveKnowledge(
  client: SupabaseClient<Database>,
  {
    organizationId,
    query,
    sourceIds,
    limit = DEFAULT_MATCH_COUNT,
    embedder,
  }: { organizationId: string; query: string; sourceIds?: string[]; limit?: number; embedder: Embedder | null },
): Promise<EvidenceResult> {
  const text = query.trim().slice(0, 1000)
  let embedding: string | undefined
  if (embedder && text) {
    try {
      embedding = toVectorLiteral(await embedder.embedQuery(text))
    } catch (error) {
      // Keyword search still works; say so in the result instead of failing.
      console.error('[knowledge] query embedding failed; using keyword search only', redact(error))
    }
  }

  const { data, error } = await client.rpc('search_knowledge', {
    p_organization_id: organizationId,
    p_query: text,
    ...(embedding ? { p_query_embedding: embedding } : {}),
    p_match_count: limit,
    ...(sourceIds?.length ? { p_source_ids: sourceIds } : {}),
  })
  if (error) {
    console.error('[knowledge] search failed', { code: error.code })
    throw new RetrievalError('Knowledge search is unavailable right now. Please try again.')
  }

  const passages: RetrievedPassage[] = (data ?? []).map((row) => ({
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceType: row.source_type,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: metadataSchema.parse(row.metadata),
    keywordRank: row.keyword_rank ?? null,
    similarity: row.similarity ?? null,
    score: row.score,
  }))

  const verdict = assessEvidence(text, passages)
  const kept = verdict.sufficient ? passages : passages.slice(0, WEAK_MATCH_LIMIT)
  return { query: text, verdict, passages: withCitations(kept), semantic: Boolean(embedding) }
}

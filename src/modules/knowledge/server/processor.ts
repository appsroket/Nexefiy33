// The knowledge processing worker: claims due sources from the queue in
// Postgres, extracts and chunks their text, embeds the chunks when embeddings
// are configured, and stores them. Runs with the privileged client (no user
// session), so every query names the organization explicitly (CLAUDE.md rule 4).
//
// State lives in knowledge_sources, never in memory: a claimed source holds a
// lease (processing_started_at, processing_attempts) and every write that
// finishes or fails it is conditional on still holding that lease, so a worker
// that was replaced after its lease expired cannot overwrite the newer run.
// Problems with the file fail the source at once with a readable reason;
// passing problems (embedding service down, storage hiccup) are retried with
// backoff up to MAX_ATTEMPTS.

import 'server-only'

import { createHash } from 'node:crypto'

import { redact } from '@/lib/logging/redact'
import type { AdminClient } from '@/lib/supabase/admin'
import type { Json, UpdateRow } from '@/lib/supabase/types'

import { chunkBlocks, TooManyChunksError, type Chunk, type ExtractedBlock } from '../domain/chunking'
import { contextItemToText, isContextKind, type ContextAttributes } from '../domain/context-kinds'
import { looksLikeInstructions } from '../domain/evidence'
import { documentTypeFor, isOrganizationStoragePath, KNOWLEDGE_BUCKET, MAX_FILE_BYTES } from '../domain/files'
import { toVectorLiteral, EmbeddingError, type Embedder } from './embeddings'
import { extractDocument, ExtractionError } from './extract'

export const MAX_ATTEMPTS = 3
export const LEASE_SECONDS = 600
const INSERT_BATCH = 100

/** Minutes to wait before retry n (1-based). */
export function retryDelayMinutes(attempt: number): number {
  return [1, 5, 15][Math.min(attempt, 3) - 1] ?? 15
}

/** A problem with the source itself; retrying won't help. The message is shown to people. */
export class PermanentProcessingError extends Error {
  override name = 'PermanentProcessingError'
}

export interface ProcessOutcome {
  sourceId: string
  organizationId: string
  result: 'ready' | 'failed' | 'retry' | 'lost_lease'
}

export interface ProcessSummary {
  claimed: number
  outcomes: ProcessOutcome[]
}

interface ClaimedSource {
  source_id: string
  organization_id: string
  attempt: number
}

interface SourceText {
  blocks: ExtractedBlock[]
  contentSha256: string
  details: Record<string, Json>
  file?: { byteSize: number; mimeType: string }
}

export async function processKnowledgeQueue({
  admin,
  embedder,
  organizationId,
  limit = 5,
  now = () => new Date(),
}: {
  admin: AdminClient
  embedder: Embedder | null
  organizationId?: string
  limit?: number
  now?: () => Date
}): Promise<ProcessSummary> {
  const { data, error } = await admin.rpc('claim_knowledge_sources', {
    p_limit: limit,
    ...(organizationId ? { p_organization_id: organizationId } : {}),
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
  })
  if (error) {
    console.error('[knowledge] claiming sources failed', { code: error.code })
    throw new Error('Could not claim knowledge sources')
  }
  const claimed = (data ?? []) as ClaimedSource[]
  const outcomes: ProcessOutcome[] = []
  // One at a time: documents can be large, and serverless memory is limited.
  for (const source of claimed) outcomes.push(await processClaimedSource(admin, source, embedder, now))
  return { claimed: claimed.length, outcomes }
}

export async function processClaimedSource(
  admin: AdminClient,
  claimed: ClaimedSource,
  embedder: Embedder | null,
  now: () => Date = () => new Date(),
): Promise<ProcessOutcome> {
  const { source_id: sourceId, organization_id: organizationId, attempt } = claimed
  const outcome = (result: ProcessOutcome['result']): ProcessOutcome => ({ sourceId, organizationId, result })
  /** An update that applies only while this run still holds the lease. */
  const updateWhileLeased = (values: UpdateRow<'knowledge_sources'>) =>
    admin
      .from('knowledge_sources')
      .update(values)
      .eq('id', sourceId)
      .eq('organization_id', organizationId)
      .eq('status', 'processing')
      .eq('processing_attempts', attempt)
      .select('id')

  try {
    const text = await loadSourceText(admin, sourceId, organizationId)
    const chunks = chunkBlocks(text.blocks)
    if (!chunks.length) throw new PermanentProcessingError('No text was found to index.')

    const vectors = embedder ? await embedder.embedDocuments(chunks.map((chunk) => chunk.content)) : null
    await replaceChunks(admin, sourceId, organizationId, chunks, vectors, embedder?.model ?? null)

    const suspected = chunks.filter((chunk) => looksLikeInstructions(chunk.content)).length
    const { data: existing } = await admin
      .from('knowledge_sources')
      .select('metadata')
      .eq('id', sourceId)
      .eq('organization_id', organizationId)
      .maybeSingle()
    const metadata = {
      ...(isRecord(existing?.metadata) ? existing.metadata : {}),
      processing: {
        ...text.details,
        chunkCount: chunks.length,
        searchMode: vectors ? 'hybrid' : 'keyword',
        suspectedInstructionChunks: suspected,
      },
    } satisfies Record<string, Json>

    const { data: updated, error } = await updateWhileLeased({
        status: 'ready',
        chunk_count: chunks.length,
        embedding_model: embedder?.model ?? null,
        content_sha256: text.contentSha256,
        last_indexed_at: now().toISOString(),
        error_message: null,
        processing_started_at: null,
        next_attempt_at: null,
        metadata,
        ...(text.file ? { byte_size: text.file.byteSize, mime_type: text.file.mimeType } : {}),
      })
    if (error) throw error
    return outcome(updated?.length ? 'ready' : 'lost_lease')
  } catch (error) {
    const permanent = error instanceof PermanentProcessingError || error instanceof ExtractionError || error instanceof TooManyChunksError
      || (error instanceof EmbeddingError && !error.transient)
    const message = userMessage(error)
    if (!permanent) console.error('[knowledge] processing failed', { sourceId, organizationId, attempt, error: redact(error) })

    if (permanent || attempt >= MAX_ATTEMPTS) {
      const { data } = await updateWhileLeased({
        status: 'failed',
        error_message: permanent ? message : `${message} We tried ${attempt} times. Reprocess it to try again.`,
        processing_started_at: null,
        next_attempt_at: null,
      })
      return outcome(data?.length ? 'failed' : 'lost_lease')
    }
    const retryAt = new Date(now().getTime() + retryDelayMinutes(attempt) * 60_000)
    const { data } = await updateWhileLeased({
      status: 'pending',
      error_message: `${message} Retrying automatically.`,
      processing_started_at: null,
      next_attempt_at: retryAt.toISOString(),
    })
    return outcome(data?.length ? 'retry' : 'lost_lease')
  }
}

function userMessage(error: unknown): string {
  if (error instanceof PermanentProcessingError || error instanceof ExtractionError || error instanceof EmbeddingError) return error.message
  if (error instanceof TooManyChunksError) return 'This document is too long to index. Split it into smaller files.'
  return 'Something went wrong while processing this source.'
}

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function loadSourceText(admin: AdminClient, sourceId: string, organizationId: string): Promise<SourceText> {
  const { data: source, error } = await admin
    .from('knowledge_sources')
    .select('id, organization_id, name, source_type, storage_bucket, storage_path, context_item_id')
    .eq('id', sourceId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) throw error
  if (!source) throw new PermanentProcessingError('This source no longer exists.')

  if (source.source_type === 'file') {
    const path = source.storage_path ?? ''
    // Defence in depth: the database already confines paths to the organization's folder.
    if (source.storage_bucket !== KNOWLEDGE_BUCKET || !isOrganizationStoragePath(path, organizationId)) {
      throw new PermanentProcessingError('This file is not stored where knowledge files belong.')
    }
    const type = documentTypeFor(path)
    if (!type) throw new PermanentProcessingError('This file type isn’t supported.')
    const { data: blob, error: downloadError } = await admin.storage.from(KNOWLEDGE_BUCKET).download(path)
    if (downloadError || !blob) {
      const status = (downloadError as { statusCode?: string | number } | null)?.statusCode
      if (String(status) === '404' || String(status) === '400') throw new PermanentProcessingError('The uploaded file is missing. Upload it again.')
      throw new Error('Download failed')
    }
    if (blob.size > MAX_FILE_BYTES) throw new PermanentProcessingError('Files can be up to 20 MB.')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const extracted = await extractDocument(bytes, type.format)
    return {
      blocks: extracted.blocks,
      contentSha256: sha256(bytes),
      details: { format: type.format, charCount: extracted.charCount, ...(extracted.pageCount ? { pageCount: extracted.pageCount } : {}) },
      file: { byteSize: bytes.byteLength, mimeType: type.mimeType },
    }
  }

  if (source.source_type === 'business_context' && source.context_item_id) {
    const { data: item, error: itemError } = await admin
      .from('business_context_items')
      .select('kind, title, body, attributes, status')
      .eq('id', source.context_item_id)
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (itemError) throw itemError
    if (!item || item.status !== 'active' || !isContextKind(item.kind)) throw new PermanentProcessingError('This entry no longer exists or is archived.')
    const text = contextItemToText({
      kind: item.kind,
      title: item.title,
      body: item.body,
      attributes: (isRecord(item.attributes) ? item.attributes : {}) as ContextAttributes,
    })
    return { blocks: [{ text }], contentSha256: sha256(text), details: { format: 'business_context', charCount: text.length } }
  }

  throw new PermanentProcessingError('This kind of source can’t be processed yet.')
}

async function replaceChunks(
  admin: AdminClient,
  sourceId: string,
  organizationId: string,
  chunks: readonly Chunk[],
  vectors: number[][] | null,
  model: string | null,
): Promise<void> {
  // The source is 'processing', so search (which only reads 'ready' sources)
  // never sees the old and new chunks mixed.
  const { error: deleteError } = await admin.from('knowledge_chunks').delete().eq('source_id', sourceId).eq('organization_id', organizationId)
  if (deleteError) throw deleteError

  for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
    const rows = chunks.slice(start, start + INSERT_BATCH).map((chunk, offset) => {
      const vector = vectors?.[start + offset]
      return {
        organization_id: organizationId,
        source_id: sourceId,
        chunk_index: chunk.index,
        content: chunk.content,
        content_sha256: sha256(chunk.content),
        token_count: chunk.tokenCount,
        embedding: vector ? toVectorLiteral(vector) : null,
        embedding_model: vector ? model : null,
        metadata: {
          ...chunk.metadata,
          ...(looksLikeInstructions(chunk.content) ? { suspectedInstructions: true } : {}),
        } as unknown as Json,
      }
    })
    const { error } = await admin.from('knowledge_chunks').insert(rows)
    if (error) throw error
  }
}

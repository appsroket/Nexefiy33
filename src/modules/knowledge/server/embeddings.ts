// Embeddings through Voyage AI (ADR-008). Feature-gated: without
// VOYAGE_API_KEY, getEmbedder() returns null and knowledge falls back to
// keyword search only — documents are still indexed and searchable.
//
// Contract-tested with a fake fetch (tests/knowledge/embeddings.test.ts); not
// yet exercised against the live Voyage API.

import 'server-only'

import { EMBEDDING_API_URL } from '@/lib/config/embeddings'
import { isFeatureConfigured, requireFeature } from '@/lib/env/server'

export interface Embedder {
  model: string
  dimensions: number
  embedDocuments(texts: readonly string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

/** `transient`: worth retrying later (rate limit, outage, network). The message is safe to show. */
export class EmbeddingError extends Error {
  override name = 'EmbeddingError'
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message)
  }
}

const BATCH_SIZE = 64
/** Stay well under the provider's per-request token limit (estimated at 4 characters per token). */
const BATCH_MAX_CHARS = 400_000
const MAX_RETRIES = 3

interface VoyageOptions {
  apiKey: string
  model: string
  dimensions: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export function createVoyageEmbedder({ apiKey, model, dimensions, fetch: fetchImpl = fetch, sleep = defaultSleep }: VoyageOptions): Embedder {
  async function request(input: readonly string[], inputType: 'document' | 'query'): Promise<number[][]> {
    let lastError: EmbeddingError | undefined
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (attempt > 0) await sleep(500 * 4 ** (attempt - 1))
      let response: Response
      try {
        response = await fetchImpl(EMBEDDING_API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ input, model, input_type: inputType, output_dimension: dimensions, truncation: true }),
          signal: AbortSignal.timeout(60_000),
        })
      } catch {
        lastError = new EmbeddingError('The embedding service could not be reached.', true)
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new EmbeddingError('The embedding service is busy or unavailable.', true)
        continue
      }
      if (response.status === 401 || response.status === 403) {
        throw new EmbeddingError('The embedding service rejected the API key. An admin needs to check VOYAGE_API_KEY.', false)
      }
      if (!response.ok) {
        throw new EmbeddingError(`The embedding service refused the request (HTTP ${response.status}).`, false)
      }
      const payload = (await response.json().catch(() => null)) as { data?: { embedding?: unknown; index?: unknown }[] } | null
      const rows = payload?.data
      if (!Array.isArray(rows) || rows.length !== input.length) {
        throw new EmbeddingError('The embedding service returned an unexpected response.', true)
      }
      const vectors: number[][] = new Array(input.length)
      for (const row of rows) {
        const index = typeof row.index === 'number' ? row.index : -1
        const embedding = row.embedding
        if (index < 0 || index >= input.length || !Array.isArray(embedding) || embedding.length !== dimensions || !embedding.every(Number.isFinite)) {
          throw new EmbeddingError('The embedding service returned vectors of the wrong shape.', false)
        }
        vectors[index] = embedding as number[]
      }
      return vectors
    }
    throw lastError ?? new EmbeddingError('The embedding service failed.', true)
  }

  return {
    model,
    dimensions,
    async embedDocuments(texts) {
      const vectors: number[][] = []
      let batch: string[] = []
      let chars = 0
      for (const text of texts) {
        if (batch.length && (batch.length >= BATCH_SIZE || chars + text.length > BATCH_MAX_CHARS)) {
          vectors.push(...(await request(batch, 'document')))
          batch = []
          chars = 0
        }
        batch.push(text)
        chars += text.length
      }
      if (batch.length) vectors.push(...(await request(batch, 'document')))
      return vectors
    },
    async embedQuery(text) {
      const [vector] = await request([text], 'query')
      return vector!
    },
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The configured embedder, or null when VOYAGE_API_KEY is not set (keyword search only). */
export function getEmbedder(): Embedder | null {
  if (!isFeatureConfigured('embeddings')) return null
  const { apiKey, model, dimensions } = requireFeature('embeddings')
  return createVoyageEmbedder({ apiKey, model, dimensions })
}

/** pgvector text form, for RPC arguments. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`
}

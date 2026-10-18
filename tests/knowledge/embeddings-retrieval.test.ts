// Voyage client contract (fake fetch — not the live API) and retrieval
// against a fake search RPC. The SQL behind search_knowledge, including
// organization boundaries, is tested in pgTAP 006.

import { describe, expect, it, vi } from 'vitest'

import type { UserClient } from '@/lib/supabase/server'
import { createVoyageEmbedder, EmbeddingError, toVectorLiteral, type Embedder } from '@/modules/knowledge/server/embeddings'
import { retrieveKnowledge, RetrievalError } from '@/modules/knowledge/server/retrieval'

import { FakeSupabase } from '../helpers/fake-supabase'

const KEY = ['test', 'voyage', 'key', 'x'.repeat(24)].join('-')
const ORG = '11111111-1111-4111-8111-111111111111'

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function vectors(count: number, dimensions = 4) {
  return { data: Array.from({ length: count }, (_, index) => ({ index, embedding: Array.from({ length: dimensions }, () => index / 10) })) }
}

const embedder = (fetchImpl: typeof fetch) =>
  createVoyageEmbedder({ apiKey: KEY, model: 'voyage-4', dimensions: 4, fetch: fetchImpl, sleep: async () => {} })

describe('Voyage embedder (contract test with a fake fetch)', () => {
  it('sends the model, input type, dimension and key, and batches documents', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { input: string[] }
      return respond(200, vectors(body.input.length))
    })
    const result = await embedder(fetchMock as unknown as typeof fetch).embedDocuments(Array.from({ length: 70 }, (_, index) => `chunk ${index}`))
    expect(result).toHaveLength(70)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.voyageai.com/v1/embeddings')
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'voyage-4', input_type: 'document', output_dimension: 4, truncation: true })
    expect(JSON.parse(String(init!.body)).input).toHaveLength(64)
  })

  it('embeds queries with the query input type', async () => {
    const fetchMock = vi.fn(async () => respond(200, vectors(1)))
    await embedder(fetchMock as unknown as typeof fetch).embedQuery('refund window')
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ input: ['refund window'], input_type: 'query' })
  })

  it('retries rate limits and outages, then succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(429, {})).mockResolvedValueOnce(respond(503, {})).mockResolvedValueOnce(respond(200, vectors(1)))
    expect(await embedder(fetchMock as unknown as typeof fetch).embedQuery('q')).toHaveLength(4)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports a transient failure after the last retry', async () => {
    const fetchMock = vi.fn(async () => respond(500, {}))
    const error = await embedder(fetchMock as unknown as typeof fetch).embedQuery('q').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EmbeddingError)
    expect((error as EmbeddingError).transient).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('treats a rejected key as permanent and never echoes the key', async () => {
    const error = (await embedder((async () => respond(401, { detail: 'bad key' })) as unknown as typeof fetch)
      .embedQuery('q')
      .catch((caught: unknown) => caught)) as EmbeddingError
    expect(error.transient).toBe(false)
    expect(error.message).not.toContain(KEY)
  })

  it('rejects vectors of the wrong dimension', async () => {
    await expect(embedder((async () => respond(200, vectors(1, 3))) as unknown as typeof fetch).embedQuery('q')).rejects.toThrow(/wrong shape/)
  })

  it('formats vectors for pgvector', () => {
    expect(toVectorLiteral([0.1, -2, 3])).toBe('[0.1,-2,3]')
  })
})

function searchRow(overrides: Record<string, unknown> = {}) {
  return {
    chunk_id: 'c1',
    source_id: 's1',
    source_name: 'Returns.pdf',
    source_type: 'file',
    chunk_index: 0,
    content: 'Refunds are accepted within 30 days of delivery.',
    metadata: { pageStart: 2, headingPath: ['Returns'] },
    keyword_rank: 0.3,
    similarity: null,
    score: 0.0164,
    ...overrides,
  }
}

describe('retrieveKnowledge', () => {
  const client = (db: FakeSupabase) => db as unknown as UserClient

  it('searches the given organization and returns cited, sufficient evidence', async () => {
    const db = new FakeSupabase()
    db.rpcHandlers.search_knowledge = () => ({ data: [searchRow()], error: null })
    const result = await retrieveKnowledge(client(db), { organizationId: ORG, query: 'How many days for refunds?', embedder: null })
    expect(db.rpcCalls).toEqual([{ name: 'search_knowledge', args: { p_organization_id: ORG, p_query: 'How many days for refunds?', p_match_count: 6 } }])
    expect(result.verdict).toEqual({ sufficient: true })
    expect(result.semantic).toBe(false)
    expect(result.passages[0]!.citation).toEqual({ label: 'S1', sourceId: 's1', sourceName: 'Returns.pdf', chunkId: 'c1', location: 'page 2, Returns' })
  })

  it('adds the query embedding when embeddings are configured', async () => {
    const db = new FakeSupabase()
    db.rpcHandlers.search_knowledge = () => ({ data: [searchRow({ similarity: 0.8 })], error: null })
    const semantic: Embedder = { model: 'voyage-4', dimensions: 2, embedDocuments: async () => [], embedQuery: async () => [0.5, 0.25] }
    const result = await retrieveKnowledge(client(db), { organizationId: ORG, query: 'money back', embedder: semantic })
    expect(db.rpcCalls[0]!.args.p_query_embedding).toBe('[0.5,0.25]')
    expect(result).toMatchObject({ semantic: true, verdict: { sufficient: true } })
  })

  it('falls back to keyword search when the query cannot be embedded', async () => {
    const db = new FakeSupabase()
    db.rpcHandlers.search_knowledge = () => ({ data: [], error: null })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: Embedder = { model: 'voyage-4', dimensions: 2, embedDocuments: async () => [], embedQuery: async () => Promise.reject(new Error('down')) }
    const result = await retrieveKnowledge(client(db), { organizationId: ORG, query: 'parking rules', embedder: broken })
    expect(db.rpcCalls[0]!.args).not.toHaveProperty('p_query_embedding')
    expect(result).toMatchObject({ semantic: false, verdict: { sufficient: false, reason: 'no_matches' }, passages: [] })
  })

  it('keeps only a few closest passages when evidence is weak', async () => {
    const db = new FakeSupabase()
    db.rpcHandlers.search_knowledge = () => ({
      data: Array.from({ length: 6 }, (_, index) => searchRow({ chunk_id: `c${index}`, content: `Unrelated passage about days ${index}.` })),
      error: null,
    })
    const result = await retrieveKnowledge(client(db), { organizationId: ORG, query: 'Which credit cards and currencies do you accept for days?', embedder: null })
    expect(result.verdict).toEqual({ sufficient: false, reason: 'weak_matches' })
    expect(result.passages).toHaveLength(3)
  })

  it('ignores malformed passage metadata and reports search failures plainly', async () => {
    const db = new FakeSupabase()
    db.rpcHandlers.search_knowledge = () => ({ data: [searchRow({ metadata: { pageStart: 'two' } })], error: null })
    const result = await retrieveKnowledge(client(db), { organizationId: ORG, query: 'refunds days', embedder: null })
    expect(result.passages[0]!.metadata).toEqual({})

    db.rpcHandlers.search_knowledge = () => ({ data: null, error: { code: '57014' } })
    await expect(retrieveKnowledge(client(db), { organizationId: ORG, query: 'refunds', embedder: null })).rejects.toThrow(RetrievalError)
  })
})

// Reads for the knowledge pages and for employees. Pages pass the user's own
// client (RLS applies); trusted server code may pass the privileged client.
// Either way every query filters by the organization explicitly.

import 'server-only'

import { z } from 'zod'

import { redact } from '@/lib/logging/redact'
import type { Database, Json } from '@/lib/supabase/types'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { BusinessContext } from '../domain/business-context'
import type { CompanyProfile, CompanySettingsJson } from '../domain/company-profile'
import { isContextKind, type ContextAttributes, type ContextItem, type ContextKind } from '../domain/context-kinds'

type Client = SupabaseClient<Database>

/** Thrown when a read fails; the message is safe to show. */
export class KnowledgeDataError extends Error {
  override name = 'KnowledgeDataError'
}

function fail(what: string, error: unknown): never {
  console.error(`[knowledge] failed to load ${what}`, redact(error))
  throw new KnowledgeDataError(`We couldn’t load the ${what}. Please try again in a moment.`)
}

function asRecord(value: Json | undefined): Record<string, Json | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

const attributesSchema = z.record(z.string(), z.union([z.string(), z.number()])).catch({})

export async function getCompanyProfile(client: Client, organizationId: string): Promise<CompanyProfile | null> {
  const { data, error } = await client
    .from('company_settings')
    .select('legal_name, industry, description, website, timezone, brand_voice, settings')
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) fail('company profile', error)
  if (!data) return null
  return {
    legalName: data.legal_name,
    industry: data.industry,
    description: data.description,
    website: data.website,
    timezone: data.timezone,
    brandVoice: data.brand_voice,
    settings: asRecord(data.settings) as CompanySettingsJson,
  }
}

function toItem(row: {
  id: string
  kind: string
  title: string
  body: string
  attributes: Json
  position: number
  status: string
  updated_at: string
}): ContextItem | null {
  if (!isContextKind(row.kind)) return null
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    attributes: attributesSchema.parse(row.attributes) as ContextAttributes,
    position: row.position,
    status: row.status === 'archived' ? 'archived' : 'active',
    updatedAt: row.updated_at,
  }
}

export async function listContextItems(
  client: Client,
  organizationId: string,
  { kinds, includeArchived = false }: { kinds?: readonly ContextKind[]; includeArchived?: boolean } = {},
): Promise<ContextItem[]> {
  let query = client
    .from('business_context_items')
    .select('id, kind, title, body, attributes, position, status, updated_at')
    .eq('organization_id', organizationId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1000)
  if (kinds?.length) query = query.in('kind', [...kinds])
  if (!includeArchived) query = query.eq('status', 'active')
  const { data, error } = await query
  if (error) fail('business context', error)
  return data.flatMap((row) => toItem(row) ?? [])
}

export async function getBusinessContext(client: Client, organizationId: string, organizationName: string): Promise<BusinessContext> {
  const [profile, items] = await Promise.all([getCompanyProfile(client, organizationId), listContextItems(client, organizationId)])
  const grouped: BusinessContext['items'] = {}
  for (const item of items) (grouped[item.kind] ??= []).push(item)
  return { organizationName, profile, items: grouped }
}

export interface KnowledgeSourceRow {
  id: string
  name: string
  sourceType: string
  status: string
  mimeType: string | null
  byteSize: number | null
  chunkCount: number
  embeddingModel: string | null
  errorMessage: string | null
  lastIndexedAt: string | null
  nextAttemptAt: string | null
  createdAt: string
  contextItemId: string | null
  storagePath: string | null
  suspectedInstructionChunks: number
}

export async function listKnowledgeSources(
  client: Client,
  organizationId: string,
  { sourceType }: { sourceType?: 'file' | 'business_context' } = {},
): Promise<KnowledgeSourceRow[]> {
  let query = client
    .from('knowledge_sources')
    .select('id, name, source_type, status, mime_type, byte_size, chunk_count, embedding_model, error_message, last_indexed_at, next_attempt_at, created_at, context_item_id, storage_path, metadata')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(500)
  if (sourceType) query = query.eq('source_type', sourceType)
  const { data, error } = await query
  if (error) fail('knowledge sources', error)
  return data.map((row) => {
    const processing = asRecord(asRecord(row.metadata).processing)
    return {
      id: row.id,
      name: row.name,
      sourceType: row.source_type,
      status: row.status,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      chunkCount: row.chunk_count,
      embeddingModel: row.embedding_model,
      errorMessage: row.error_message,
      lastIndexedAt: row.last_indexed_at,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at,
      contextItemId: row.context_item_id,
      storagePath: row.storage_path,
      suspectedInstructionChunks: typeof processing.suspectedInstructionChunks === 'number' ? processing.suspectedInstructionChunks : 0,
    }
  })
}

export interface KnowledgeStatusCounts {
  pending: number
  processing: number
  ready: number
  failed: number
  archived: number
}

export function countByStatus(sources: readonly Pick<KnowledgeSourceRow, 'status'>[]): KnowledgeStatusCounts {
  const counts: KnowledgeStatusCounts = { pending: 0, processing: 0, ready: 0, failed: 0, archived: 0 }
  for (const source of sources) if (source.status in counts) counts[source.status as keyof KnowledgeStatusCounts] += 1
  return counts
}

'use server'

// Server Actions for business context, documents and knowledge search.
//
// Every action re-verifies the session with Supabase Auth and runs under the
// user's own session, so RLS and storage policies decide what is allowed
// (operators manage most context and documents; admins manage escalation
// contacts, templates and the company profile). A write that changes no rows
// means the user wasn't allowed to make it. Ids sent by the browser are
// validated but never trusted.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { fieldErrorsFromZod, parseFormData } from '@/lib/forms/parse-form'
import { createRateLimiter } from '@/lib/rate-limit'
import { createUserClient } from '@/lib/supabase/server'
import { getVerifiedUser, SESSION_ENDED_MESSAGE } from '@/modules/identity/server/session'

import { CONTEXT_KIND_DEFINITIONS, isContextKind } from '../domain/context-kinds'
import { INSUFFICIENT_EVIDENCE_MESSAGE, type EvidenceResult } from '../domain/evidence'
import { checkFile, documentTypeFor, isOrganizationStoragePath, KNOWLEDGE_BUCKET } from '../domain/files'
import { companyProfileSchema, contextItemSchema, knowledgeQuerySchema, registerUploadSchema } from '../domain/schemas'
import { getEmbedder } from './embeddings'
import { retrieveKnowledge, RetrievalError } from './retrieval'
import { scheduleKnowledgeProcessing } from './scheduling'

const NOT_ALLOWED = 'You don’t have permission to do that in this workspace.'
const FIX_FIELDS = 'Please correct the highlighted fields.'
const INVALID_CONTENT =
  'This can’t be saved. Check that it doesn’t contain a password, API key or other credential, and that every field is valid.'

const searchLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 })

const uuid = z.uuid()

function readUuid(value: unknown): string | null {
  const parsed = uuid.safeParse(value)
  return parsed.success ? parsed.data : null
}

function logFailure(action: string, error: { code?: string } | null) {
  console.error(`[knowledge] ${action} failed`, { code: error?.code ?? 'unknown' })
}

function refresh() {
  revalidatePath('/app/knowledge', 'layout')
}

// Business context items ----------------------------------------------------------

export async function saveContextItem(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const organizationId = readUuid(formData.get('organizationId'))
  const kind = formData.get('kind')
  const rawId = formData.get('id')
  const itemId = rawId ? readUuid(rawId) : null
  if (!organizationId || !isContextKind(kind) || (rawId && !itemId)) return actionError(NOT_ALLOWED)

  const parsed = parseFormData(contextItemSchema(kind), formData)
  if (!parsed.ok) return parsed.state

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { title, body, attributes } = parsed.data
  const result = itemId
    ? await supabase
        .from('business_context_items')
        .update({ title, body, attributes })
        .eq('id', itemId)
        .eq('organization_id', organizationId)
        .eq('kind', kind)
        .select('id')
    : await supabase.from('business_context_items').insert({ organization_id: organizationId, kind, title, body, attributes }).select('id')

  if (result.error) {
    if (result.error.code === '42501') return actionError(NOT_ALLOWED)
    if (result.error.code === '23514') return actionError(INVALID_CONTENT)
    logFailure('saving business context', result.error)
    return actionError('We couldn’t save this. Please try again.')
  }
  if (result.data.length === 0) return actionError(NOT_ALLOWED)

  const definition = CONTEXT_KIND_DEFINITIONS[kind]
  if (definition.indexed) scheduleKnowledgeProcessing(organizationId)
  refresh()
  return actionSuccess(`${definition.label} saved.`)
}

export async function setContextItemArchived(organizationId: string, itemId: string, archived: boolean): Promise<ActionState> {
  const org = readUuid(organizationId)
  const id = readUuid(itemId)
  if (!org || !id) return actionError(NOT_ALLOWED)

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase
    .from('business_context_items')
    .update({ status: archived ? 'archived' : 'active' })
    .eq('id', id)
    .eq('organization_id', org)
    .select('id, kind')
  if (error) {
    logFailure('archiving business context', error)
    return actionError('We couldn’t update this entry. Please try again.')
  }
  if (data.length === 0) return actionError(NOT_ALLOWED)
  if (!archived) scheduleKnowledgeProcessing(org)
  refresh()
  return actionSuccess(archived ? 'Archived. Employees no longer use it.' : 'Restored.')
}

export async function deleteContextItem(organizationId: string, itemId: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const id = readUuid(itemId)
  if (!org || !id) return actionError(NOT_ALLOWED)

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase.from('business_context_items').delete().eq('id', id).eq('organization_id', org).select('id')
  if (error) {
    logFailure('deleting business context', error)
    return actionError('We couldn’t delete this entry. Please try again.')
  }
  if (data.length === 0) return actionError(NOT_ALLOWED)
  refresh()
  return actionSuccess('Deleted.')
}

// Company profile -----------------------------------------------------------------

export async function updateCompanyProfile(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const organizationId = readUuid(formData.get('organizationId'))
  if (!organizationId) return actionError(NOT_ALLOWED)
  const parsed = parseFormData(companyProfileSchema, formData)
  if (!parsed.ok) return parsed.state

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const profile = parsed.data
  const { data, error } = await supabase
    .from('company_settings')
    .update({
      legal_name: profile.legalName,
      industry: profile.industry,
      website: profile.website,
      description: profile.description,
      timezone: profile.timezone,
      brand_voice: profile.brandVoice,
      settings: profile.settings as never,
    })
    .eq('organization_id', organizationId)
    .select('organization_id')
  if (error) {
    if (error.code === '23514') return actionError(INVALID_CONTENT)
    logFailure('company profile update', error)
    return actionError('We couldn’t save the company profile. Please try again.')
  }
  if (data.length === 0) return actionError('Only admins and owners can change the company profile.')

  revalidatePath('/app', 'layout')
  return actionSuccess('Company profile saved.')
}

// Documents -----------------------------------------------------------------------

/**
 * Records a file the browser has already uploaded to the knowledge bucket
 * (storage policies only let operators write into their organization's
 * folder) and queues it for processing.
 */
export async function registerKnowledgeUpload(input: {
  organizationId: string
  uploadId: string
  path: string
  name: string
}): Promise<ActionState> {
  const organizationId = readUuid(input.organizationId)
  const parsed = registerUploadSchema.safeParse(input)
  if (!organizationId || !parsed.success) return actionError('That upload isn’t valid. Please try again.')
  const { uploadId, path, name } = parsed.data
  if (!isOrganizationStoragePath(path, organizationId) || !path.startsWith(`${organizationId}/${uploadId}/`)) {
    return actionError('That upload isn’t valid. Please try again.')
  }
  const type = documentTypeFor(name)
  if (!type || documentTypeFor(path)?.format !== type.format) return actionError('This file type isn’t supported.')

  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  if (!user) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  // Confirm the object exists (and read its real size) under the user's own access.
  const folder = `${organizationId}/${uploadId}`
  const fileName = path.slice(folder.length + 1)
  const { data: listing, error: listError } = await supabase.storage.from(KNOWLEDGE_BUCKET).list(folder, { limit: 10, search: fileName })
  const object = listing?.find((entry) => entry.name === fileName)
  if (listError || !object) return actionError('We couldn’t find the uploaded file. Please upload it again.')
  const size = Number((object.metadata as { size?: unknown } | null)?.size ?? 0)
  const check = checkFile(name, size)
  if (!check.ok) {
    await supabase.storage.from(KNOWLEDGE_BUCKET).remove([path])
    return actionError(check.reason)
  }

  const { data, error } = await supabase
    .from('knowledge_sources')
    .insert({
      organization_id: organizationId,
      name: name.slice(0, 300),
      source_type: 'file',
      storage_bucket: KNOWLEDGE_BUCKET,
      storage_path: path,
      mime_type: type.mimeType,
      byte_size: size,
      created_by: user.id,
    })
    .select('id')
  if (error || data.length === 0) {
    await supabase.storage.from(KNOWLEDGE_BUCKET).remove([path])
    if (error?.code === '42501' || !error) return actionError(NOT_ALLOWED)
    logFailure('registering an upload', error)
    return actionError('We couldn’t add this document. Please try again.')
  }

  scheduleKnowledgeProcessing(organizationId)
  refresh()
  return actionSuccess(`${name} uploaded. Processing has started.`)
}

export async function reprocessKnowledgeSource(organizationId: string, sourceId: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const id = readUuid(sourceId)
  if (!org || !id) return actionError(NOT_ALLOWED)

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase.rpc('reprocess_knowledge_source', { p_source_id: id })
  if (error) {
    if (error.code === 'P0002') return actionError('This source can’t be reprocessed right now. It may already be queued or processing.')
    logFailure('reprocessing a source', error)
    return actionError('We couldn’t queue this source. Please try again.')
  }
  scheduleKnowledgeProcessing(data)
  refresh()
  return actionSuccess('Queued for processing.')
}

export async function deleteKnowledgeSource(organizationId: string, sourceId: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const id = readUuid(sourceId)
  if (!org || !id) return actionError(NOT_ALLOWED)

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase
    .from('knowledge_sources')
    .delete()
    .eq('id', id)
    .eq('organization_id', org)
    .neq('source_type', 'business_context')
    .select('storage_bucket, storage_path')
  if (error) {
    logFailure('deleting a source', error)
    return actionError('We couldn’t delete this document. Please try again.')
  }
  const removed = data[0]
  if (!removed) return actionError(NOT_ALLOWED)

  if (removed.storage_bucket === KNOWLEDGE_BUCKET && removed.storage_path && isOrganizationStoragePath(removed.storage_path, org)) {
    const { error: storageError } = await supabase.storage.from(KNOWLEDGE_BUCKET).remove([removed.storage_path])
    // The document is already out of search; a leftover file stays private to the organization.
    if (storageError) console.error('[knowledge] deleted source left its file in storage', { sourceId: id })
  }
  refresh()
  return actionSuccess('Document deleted.')
}

// Search --------------------------------------------------------------------------

export type KnowledgeSearchState =
  | { status: 'idle' }
  | { status: 'error'; message: string; fieldErrors?: Record<string, string[] | undefined> }
  | { status: 'done'; result: EvidenceResult; insufficientMessage: string }

export async function searchKnowledgeAction(_previous: KnowledgeSearchState, formData: FormData): Promise<KnowledgeSearchState> {
  const organizationId = readUuid(formData.get('organizationId'))
  if (!organizationId) return { status: 'error', message: NOT_ALLOWED }
  const query = knowledgeQuerySchema.safeParse(formData.get('query'))
  if (!query.success) return { status: 'error', message: FIX_FIELDS, fieldErrors: { query: fieldErrorsFromZod(query.error)._form } }

  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  if (!user) return { status: 'error', message: SESSION_ENDED_MESSAGE }
  if (!searchLimiter(user.id)) return { status: 'error', message: 'Too many searches in a short time. Wait a minute and try again.' }

  try {
    const result = await retrieveKnowledge(supabase, { organizationId, query: query.data, embedder: getEmbedder() })
    return { status: 'done', result, insufficientMessage: INSUFFICIENT_EVIDENCE_MESSAGE }
  } catch (error) {
    return { status: 'error', message: error instanceof RetrievalError ? error.message : 'Search failed. Please try again.' }
  }
}

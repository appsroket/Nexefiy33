// Knowledge Server Actions with Supabase, scheduling and Next.js replaced by
// fakes. Authorization itself is enforced by RLS and storage policies (pgTAP
// 006); these tests check that actions validate input before touching
// Supabase, verify the session, keep every write inside the workspace,
// translate refusals, and clean up after failed uploads.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActionState } from '@/lib/forms/action-state'

import { FakeSupabase } from '../helpers/fake-supabase'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const UPLOAD = '33333333-3333-4333-8333-333333333333'
const ITEM = '55555555-5555-4555-8555-555555555555'
const SOURCE = '44444444-4444-4444-8444-444444444444'
const ME = '66666666-6666-4666-8666-666666666666'

let db: FakeSupabase
let signedIn = true

const scheduleKnowledgeProcessing = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createUserClient: async () =>
    Object.assign(db, {
      auth: {
        getUser: async () => (signedIn ? { data: { user: { id: ME, email: 'me@example.test' } }, error: null } : { data: { user: null }, error: { code: 'session_not_found' } }),
      },
    }),
}))
vi.mock('@/modules/knowledge/server/scheduling', () => ({ scheduleKnowledgeProcessing: (org: string) => scheduleKnowledgeProcessing(org) }))
vi.mock('@/modules/knowledge/server/embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/knowledge/server/embeddings')>()),
  getEmbedder: () => null,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const actions = await import('@/modules/knowledge/server/actions')

const IDLE: ActionState = { status: 'idle' }

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

beforeEach(() => {
  db = new FakeSupabase()
  signedIn = true
  scheduleKnowledgeProcessing.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('saveContextItem', () => {
  it('rejects unknown kinds and malformed ids before touching Supabase', async () => {
    expect(await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'secret', title: 'x' }))).toMatchObject({ status: 'error' })
    expect(await actions.saveContextItem(IDLE, form({ organizationId: 'nope', kind: 'faq', title: 'x', body: 'y' }))).toMatchObject({ status: 'error' })
    expect(await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'faq', id: 'nope', title: 'x', body: 'y' }))).toMatchObject({ status: 'error' })
    expect(db.queries).toEqual([])
  })

  it('returns field errors for invalid input', async () => {
    const state = await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'template', title: 'Welcome', body: 'Hi' }))
    expect(state).toMatchObject({ status: 'error', fieldErrors: { attr_channel: expect.any(Array) } })
    expect(db.queries).toEqual([])
  })

  it('requires a live session', async () => {
    signedIn = false
    expect(await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'faq', title: 'Q?', body: 'A.' }))).toMatchObject({ code: 'session_ended' })
  })

  it('creates an entry in the workspace and starts indexing it', async () => {
    const state = await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'faq', title: ' Do you ship abroad? ', body: 'Yes.' }))
    expect(state).toEqual({ status: 'success', message: 'FAQ saved.' })
    expect(db.tables.business_context_items).toEqual([
      expect.objectContaining({ organization_id: ORG, kind: 'faq', title: 'Do you ship abroad?', body: 'Yes.', attributes: {} }),
    ])
    expect(scheduleKnowledgeProcessing).toHaveBeenCalledWith(ORG)
  })

  it('does not index escalation contacts', async () => {
    await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'escalation_contact', title: 'Dana', attr_email: 'dana@example.test' }))
    expect(scheduleKnowledgeProcessing).not.toHaveBeenCalled()
  })

  it('updates only the workspace’s entry of the same kind', async () => {
    db.tables.business_context_items = [{ id: ITEM, organization_id: ORG, kind: 'faq', title: 'Old', body: 'Old', attributes: {} }]
    await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'faq', id: ITEM, title: 'New', body: 'New answer' }))
    expect(db.queries.at(-1)!.filters).toEqual([
      ['id', 'eq', ITEM],
      ['organization_id', 'eq', ORG],
      ['kind', 'eq', 'faq'],
    ])
    expect(db.tables.business_context_items![0]).toMatchObject({ title: 'New', body: 'New answer' })
  })

  it('reports a change that touched no rows, or a refusal, as not allowed', async () => {
    expect(await actions.saveContextItem(IDLE, form({ organizationId: OTHER_ORG, kind: 'faq', id: ITEM, title: 'Q', body: 'A' }))).toMatchObject({
      message: 'You don’t have permission to do that in this workspace.',
    })
    db.errorFor = () => ({ code: '42501' })
    expect(await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'template', title: 'T', body: 'B', attr_channel: 'email' }))).toMatchObject({
      message: 'You don’t have permission to do that in this workspace.',
    })
    db.errorFor = () => ({ code: '23514' })
    expect(await actions.saveContextItem(IDLE, form({ organizationId: ORG, kind: 'faq', title: 'Q', body: 'A' }))).toMatchObject({ message: expect.stringMatching(/credential/) })
  })
})

describe('updateCompanyProfile', () => {
  it('saves profile columns and versioned settings', async () => {
    db.tables.company_settings = [{ organization_id: ORG, settings: {} }]
    const state = await actions.updateCompanyProfile(IDLE, form({ organizationId: ORG, timezone: 'Europe/Lisbon', industry: 'Retail', brandVoice: 'Warm.', tone: 'warm' }))
    expect(state).toEqual({ status: 'success', message: 'Company profile saved.' })
    expect(db.tables.company_settings[0]).toMatchObject({
      industry: 'Retail',
      brand_voice: 'Warm.',
      timezone: 'Europe/Lisbon',
      settings: { schemaVersion: 1, brandVoice: { tone: ['warm'] } },
    })
  })

  it('explains that only admins can change it when no row changed', async () => {
    expect(await actions.updateCompanyProfile(IDLE, form({ organizationId: ORG, timezone: 'UTC' }))).toMatchObject({ message: /admins and owners/ })
  })
})

describe('registerKnowledgeUpload', () => {
  const path = `${ORG}/${UPLOAD}/Policy.pdf`
  const upload = (overrides: Partial<{ organizationId: string; uploadId: string; path: string; name: string }> = {}) =>
    actions.registerKnowledgeUpload({ organizationId: ORG, uploadId: UPLOAD, path, name: 'Policy.pdf', ...overrides })

  it('refuses paths outside the workspace folder without touching Supabase', async () => {
    for (const bad of [`${OTHER_ORG}/${UPLOAD}/Policy.pdf`, `${ORG}/../${OTHER_ORG}/Policy.pdf`, `${ORG}/${UPLOAD}/../x.pdf`, `${ORG}/Policy.pdf`]) {
      expect(await upload({ path: bad }), bad).toMatchObject({ status: 'error' })
    }
    expect(await upload({ uploadId: '77777777-7777-4777-8777-777777777777' })).toMatchObject({ status: 'error' })
    expect(db.queries).toEqual([])
  })

  it('refuses unsupported or mismatched file types', async () => {
    expect(await upload({ name: 'Policy.exe' })).toMatchObject({ message: 'This file type isn’t supported.' })
    expect(await upload({ name: 'Policy.docx' })).toMatchObject({ message: 'This file type isn’t supported.' })
  })

  it('needs the uploaded object to exist', async () => {
    expect(await upload()).toMatchObject({ message: expect.stringMatching(/couldn’t find the uploaded file/) })
  })

  it('removes a file that is too large', async () => {
    db.files.set(`knowledge/${path}`, new Uint8Array(21 * 1024 * 1024))
    expect(await upload()).toMatchObject({ message: 'Files can be up to 20 MB.' })
    expect(db.removedFiles).toEqual([path])
  })

  it('removes the file when the source can’t be recorded', async () => {
    db.files.set(`knowledge/${path}`, new Uint8Array(10))
    db.errorFor = (table, operation) => (table === 'knowledge_sources' && operation === 'insert' ? { code: '42501' } : null)
    expect(await upload()).toMatchObject({ message: 'You don’t have permission to do that in this workspace.' })
    expect(db.removedFiles).toEqual([path])
  })

  it('records the file with its real size and queues it', async () => {
    db.files.set(`knowledge/${path}`, new Uint8Array(1234))
    expect(await upload()).toEqual({ status: 'success', message: 'Policy.pdf uploaded. Processing has started.' })
    expect(db.tables.knowledge_sources).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        source_type: 'file',
        storage_bucket: 'knowledge',
        storage_path: path,
        mime_type: 'application/pdf',
        byte_size: 1234,
      }),
    ])
    // The database fills created_by from the session; clients may not write it.
    expect(db.tables.knowledge_sources?.[0]).not.toHaveProperty('created_by')
    expect(scheduleKnowledgeProcessing).toHaveBeenCalledWith(ORG)
  })
})

describe('documents', () => {
  it('deletes only file sources of the workspace and removes their files', async () => {
    const path = `${ORG}/${UPLOAD}/Policy.pdf`
    db.tables.knowledge_sources = [{ id: SOURCE, organization_id: ORG, source_type: 'file', storage_bucket: 'knowledge', storage_path: path }]
    expect(await actions.deleteKnowledgeSource(ORG, SOURCE)).toEqual({ status: 'success', message: 'Document deleted.' })
    expect(db.queries.at(-1)!.filters).toContainEqual(['source_type', 'neq', 'business_context'])
    expect(db.removedFiles).toEqual([path])
    expect(await actions.deleteKnowledgeSource(ORG, SOURCE)).toMatchObject({ status: 'error' })
  })

  it('reprocesses through the database function and queues the returned organization', async () => {
    db.rpcHandlers.reprocess_knowledge_source = () => ({ data: ORG, error: null })
    expect(await actions.reprocessKnowledgeSource(ORG, SOURCE)).toEqual({ status: 'success', message: 'Queued for processing.' })
    expect(db.rpcCalls).toEqual([{ name: 'reprocess_knowledge_source', args: { p_source_id: SOURCE } }])
    expect(scheduleKnowledgeProcessing).toHaveBeenCalledWith(ORG)

    db.rpcHandlers.reprocess_knowledge_source = () => ({ data: null, error: { code: 'P0002' } })
    expect(await actions.reprocessKnowledgeSource(ORG, SOURCE)).toMatchObject({ message: expect.stringMatching(/can’t be reprocessed/) })
  })
})

describe('searchKnowledgeAction', () => {
  it('validates the question and searches the given workspace', async () => {
    expect(await actions.searchKnowledgeAction({ status: 'idle' }, form({ organizationId: ORG, query: ' ' }))).toMatchObject({ status: 'error' })
    db.rpcHandlers.search_knowledge = () => ({ data: [], error: null })
    const state = await actions.searchKnowledgeAction({ status: 'idle' }, form({ organizationId: ORG, query: 'refund policy' }))
    expect(state).toMatchObject({ status: 'done', result: { verdict: { sufficient: false, reason: 'no_matches' }, passages: [] } })
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_organization_id: ORG, p_query: 'refund policy' })
  })
})

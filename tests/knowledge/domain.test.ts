// Business context rules, form schemas, file rules and the context pack. The
// database enforces the same rules (pgTAP 006); the sync tests below keep the
// TypeScript definitions and the migration from drifting apart.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { formatBusinessContextForModel, profileCompleteness, type BusinessContext } from '@/modules/knowledge/domain/business-context'
import { describeWeeklyHours, openStateAt, timeRangeProblems } from '@/modules/knowledge/domain/company-profile'
import {
  canManageContextKind,
  CONTEXT_KIND_DEFINITIONS,
  CONTEXT_KINDS,
  contextItemToText,
  contextKindBySlug,
  type ContextItem,
} from '@/modules/knowledge/domain/context-kinds'
import { checkFile, documentTypeFor, isOrganizationStoragePath, knowledgeStoragePath, safeFileName } from '@/modules/knowledge/domain/files'
import { attributeFieldName, companyProfileSchema, contextItemSchema } from '@/modules/knowledge/domain/schemas'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const UPLOAD = '33333333-3333-4333-8333-333333333333'

const root = join(import.meta.dirname, '../..')
const migrations = readdirSync(join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(root, 'supabase/migrations', name), 'utf8'))
  .join('\n')

function form(values: Record<string, string>): Record<string, string> {
  return values
}

describe('context kinds stay in sync with the migration', () => {
  it('lists the same kinds as the check constraint', () => {
    const match = /kind text not null check \(kind in \(([^)]+)\)\)/.exec(migrations.replace(/\s+/g, ' '))
    const sqlKinds = [...match![1]!.matchAll(/'(\w+)'/g)].map((entry) => entry[1])
    expect(sqlKinds).toEqual([...CONTEXT_KINDS])
  })

  it('declares exactly the admin-only kinds that the policies require admin for', () => {
    const adminKinds = CONTEXT_KINDS.filter((kind) => CONTEXT_KIND_DEFINITIONS[kind].managedBy === 'admin')
    expect(adminKinds).toEqual(['escalation_contact', 'template'])
    expect(migrations).toContain("kind in ('escalation_contact', 'template')")
  })

  it('uses only attribute keys the database schema allows, per kind', () => {
    for (const kind of CONTEXT_KINDS) {
      const branch = new RegExp(`when '${kind}' then extensions\\.jsonb_matches_schema\\(([\\s\\S]*?)\\$schema\\$::json`).exec(migrations)
      expect(branch, kind).not.toBeNull()
      for (const field of CONTEXT_KIND_DEFINITIONS[kind].attributes) expect(branch![1], `${kind}.${field.key}`).toContain(`"${field.key}"`)
    }
  })

  it('does not index escalation contacts, matching the sync trigger', () => {
    expect(CONTEXT_KINDS.filter((kind) => !CONTEXT_KIND_DEFINITIONS[kind].indexed)).toEqual(['escalation_contact'])
    expect(migrations).toContain("if new.kind = 'escalation_contact' then")
  })

  it('has unique URL slugs', () => {
    const slugs = CONTEXT_KINDS.map((kind) => CONTEXT_KIND_DEFINITIONS[kind].slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(contextKindBySlug('faqs')?.kind).toBe('faq')
    expect(contextKindBySlug('nope')).toBeUndefined()
  })
})

describe('roles', () => {
  it('lets operators manage most kinds and only admins manage contacts and templates', () => {
    expect(canManageContextKind('operator', 'faq')).toBe(true)
    expect(canManageContextKind('operator', 'template')).toBe(false)
    expect(canManageContextKind('admin', 'escalation_contact')).toBe(true)
    expect(canManageContextKind('viewer', 'faq')).toBe(false)
  })
})

describe('contextItemSchema', () => {
  it('builds attributes from attr_ fields and drops empty ones', () => {
    const parsed = contextItemSchema('goal').parse(
      form({ title: ' Faster replies ', body: '', [attributeFieldName('metric')]: 'First reply time', [attributeFieldName('target')]: '', [attributeFieldName('period')]: 'monthly' }),
    )
    expect(parsed).toEqual({ kind: 'goal', title: 'Faster replies', body: '', attributes: { metric: 'First reply time', period: 'monthly' } })
  })

  it('requires an email or phone for escalation contacts', () => {
    const result = contextItemSchema('escalation_contact').safeParse(form({ title: 'Dana', body: '' }))
    expect(result.success).toBe(false)
    const ok = contextItemSchema('escalation_contact').parse(form({ title: 'Dana', [attributeFieldName('phone')]: '+351 912 345 678', [attributeFieldName('priority')]: '2' }))
    expect(ok.attributes).toEqual({ phone: '+351 912 345 678', priority: 2 })
  })

  it('requires a channel and message for templates and an answer for FAQs', () => {
    expect(contextItemSchema('template').safeParse(form({ title: 'Welcome', body: 'Hi' })).success).toBe(false)
    expect(contextItemSchema('template').safeParse(form({ title: 'Welcome', body: 'Hi', [attributeFieldName('channel')]: 'email' })).success).toBe(true)
    expect(contextItemSchema('faq').safeParse(form({ title: 'Q?', body: '   ' })).success).toBe(false)
  })

  it('normalizes product web pages and rejects bad emails', () => {
    expect(contextItemSchema('product').parse(form({ title: 'Plan', [attributeFieldName('url')]: 'example.com/plan' })).attributes).toEqual({ url: 'https://example.com/plan' })
    expect(contextItemSchema('department').safeParse(form({ title: 'Ops', [attributeFieldName('email')]: 'not-an-email' })).success).toBe(false)
  })
})

describe('companyProfileSchema', () => {
  const base = { timezone: 'Europe/Lisbon', legalName: 'Acme Lda', industry: 'Retail' }

  it('builds settings with schema version, hours and brand voice', () => {
    const hours = Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri'].flatMap((day) => [[`hours_${day}_open`, '09:00'], [`hours_${day}_close`, '17:30']]),
    )
    const parsed = companyProfileSchema.parse({
      ...base,
      ...hours,
      hours_sat_closed: 'on',
      hours_sun_closed: 'on',
      hoursEnabled: 'on',
      tone: 'warm, direct, warm',
      avoidPhrases: 'ASAP\nPer my last email',
      teamSize: '11-50',
      foundedYear: '2015',
    })
    expect(parsed.settings).toEqual({
      schemaVersion: 1,
      profile: { teamSize: '11-50', foundedYear: 2015 },
      operatingHours: {
        weekly: {
          mon: [{ open: '09:00', close: '17:30' }],
          tue: [{ open: '09:00', close: '17:30' }],
          wed: [{ open: '09:00', close: '17:30' }],
          thu: [{ open: '09:00', close: '17:30' }],
          fri: [{ open: '09:00', close: '17:30' }],
          sat: [],
          sun: [],
        },
      },
      brandVoice: { tone: ['warm', 'direct'], avoidPhrases: ['ASAP', 'Per my last email'] },
    })
  })

  it('rejects closing before opening and missing times', () => {
    const result = companyProfileSchema.safeParse({ ...base, hoursEnabled: 'on', hours_mon_open: '18:00', hours_mon_close: '09:00' })
    expect(result.success).toBe(false)
    const issues = result.success ? [] : result.error.issues.map((issue) => issue.message)
    expect(issues).toContain('Closing time must be after opening time.')
    expect(issues).toContain('Enter opening and closing times, or mark the day closed.')
  })

  it('leaves hours out when not enabled and rejects unknown time zones', () => {
    expect(companyProfileSchema.parse(base).settings).toEqual({ schemaVersion: 1 })
    expect(companyProfileSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false)
  })
})

describe('operating hours', () => {
  const weekly = { mon: [{ open: '09:00', close: '17:00' }], sat: [] }

  it('decides open or closed in the business’s own time zone', () => {
    // Monday 2026-10-19 07:30 UTC is 08:30 in Lisbon (WEST, UTC+1): closed. 08:30 UTC is 09:30 there: open.
    expect(openStateAt(weekly, 'Europe/Lisbon', new Date('2026-10-19T07:30:00Z'))).toEqual({ known: true, open: false, weekday: 'mon', localTime: '08:30' })
    expect(openStateAt(weekly, 'Europe/Lisbon', new Date('2026-10-19T08:30:00Z'))).toMatchObject({ open: true })
    expect(openStateAt(weekly, 'America/New_York', new Date('2026-10-19T08:30:00Z'))).toMatchObject({ open: false, localTime: '04:30' })
  })

  it('is unknown when no hours are configured', () => {
    expect(openStateAt(undefined, 'UTC', new Date())).toEqual({ known: false })
  })

  it('describes every day and checks overlaps', () => {
    expect(describeWeeklyHours(weekly)).toContain('Monday: 09:00–17:00')
    expect(describeWeeklyHours(weekly)).toContain('Sunday: closed')
    expect(timeRangeProblems([{ open: '09:00', close: '12:00' }, { open: '11:00', close: '14:00' }])).toEqual(['Opening hours on the same day must not overlap.'])
    expect(timeRangeProblems([{ open: '00:00', close: '24:00' }])).toEqual([])
  })
})

describe('files', () => {
  it('accepts supported types up to 20 MB, by extension', () => {
    expect(checkFile('Policy.PDF', 1000)).toMatchObject({ ok: true, type: { format: 'pdf' } })
    expect(checkFile('notes.md', 10)).toMatchObject({ ok: true, type: { mimeType: 'text/markdown' } })
    expect(checkFile('sheet.xlsx', 10)).toMatchObject({ ok: false })
    expect(checkFile('big.pdf', 21 * 1024 * 1024)).toEqual({ ok: false, reason: 'Files can be up to 20 MB.' })
    expect(checkFile('empty.txt', 0)).toMatchObject({ ok: false })
    expect(documentTypeFor('archive.tar.gz')).toBeUndefined()
  })

  it('makes storage-safe names and paths inside the organization folder', () => {
    expect(safeFileName('../../Prix été 2026 (final).pdf')).toBe('Prix-ete-2026-final.pdf')
    expect(safeFileName('…')).toBe('document')
    const path = knowledgeStoragePath(ORG, UPLOAD, 'Returns policy.pdf')
    expect(path).toBe(`${ORG}/${UPLOAD}/Returns-policy.pdf`)
    expect(isOrganizationStoragePath(path, ORG)).toBe(true)
    expect(isOrganizationStoragePath(path, OTHER_ORG)).toBe(false)
    expect(isOrganizationStoragePath(`${ORG}/../${OTHER_ORG}/x.pdf`, ORG)).toBe(false)
    expect(isOrganizationStoragePath(`${ORG}/${UPLOAD}/../x.pdf`, ORG)).toBe(false)
    expect(isOrganizationStoragePath(`${ORG}/x.pdf`, ORG)).toBe(false)
  })
})

describe('business context pack', () => {
  const item = (overrides: Partial<ContextItem>): ContextItem => ({
    id: 'i',
    kind: 'faq',
    title: 'T',
    body: '',
    attributes: {},
    position: 0,
    status: 'active',
    updatedAt: '2026-10-18T00:00:00Z',
    ...overrides,
  })

  it('renders indexable text that names the kind', () => {
    expect(contextItemToText(item({ title: 'Do you ship abroad?', body: 'Yes, to the EU.' }))).toBe('FAQ: Do you ship abroad?\n\nAnswer: Yes, to the EU.')
    expect(contextItemToText(item({ kind: 'template', title: 'Refund done', body: 'Hi {{name}}', attributes: { channel: 'email', subject: 'Refund' } }))).toBe(
      'Communication template: Refund done\n\nChannel: Email\nSubject: Refund\n\nHi {{name}}',
    )
  })

  const context: BusinessContext = {
    organizationName: 'Acme',
    profile: {
      legalName: 'Acme Lda',
      industry: 'Retail',
      description: 'We sell bikes.',
      website: null,
      timezone: 'Europe/Lisbon',
      brandVoice: 'Warm and direct.',
      settings: { operatingHours: { weekly: { mon: [{ open: '09:00', close: '17:00' }] } }, brandVoice: { avoidPhrases: ['ASAP'] } },
    },
    items: {
      escalation_contact: [item({ kind: 'escalation_contact', title: 'Dana Lee', body: 'Billing disputes', attributes: { role: 'Finance lead', email: 'dana@example.test' } })],
      goal: [item({ kind: 'goal', title: 'Faster replies', attributes: { metric: 'First reply time', target: '< 1 hour' } })],
    },
  }

  it('gives employees hours, open state, voice, goals and contacts — and says it is not authorization', () => {
    const text = formatBusinessContextForModel(context, new Date('2026-10-19T08:30:00Z'))
    expect(text).toMatch(/does not grant permissions or approve actions/)
    expect(text).toContain('Now: Monday 09:30 local time — open')
    expect(text).toContain('Avoid: ASAP')
    expect(text).toContain('- Dana Lee\n  Role: Finance lead\n  Email: dana@example.test\n  Escalate when: Billing disputes')
    expect(text).toContain('KPI: First reply time')
  })

  it('tells employees not to contact anyone when no escalation contact exists', () => {
    const text = formatBusinessContextForModel({ ...context, items: {} }, new Date())
    expect(text).toMatch(/None configured\. If a task needs a person, stop and report it/)
  })

  it('reports what is still missing from the profile', () => {
    expect(profileCompleteness(context)).toEqual({
      done: 5,
      total: 8,
      missing: ['Products and services', 'Target customers', 'Frequently asked questions'],
    })
  })
})

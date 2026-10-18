// The business context pack: everything an AI employee should know about the
// organization before it starts a task — profile, hours (and whether the
// business is open now), brand voice, goals, departments, escalation contacts
// and approved templates. Assembled from data authorized members configured,
// so it is more trustworthy than a document, but it is still context, never
// authorization: tools and approvals are decided server-side.

import { describeWeeklyHours, openStateAt, WEEKDAY_LABELS, type CompanyProfile } from './company-profile'
import { CONTEXT_KIND_DEFINITIONS, describeAttributes, type ContextItem, type ContextKind } from './context-kinds'

export interface BusinessContext {
  organizationName: string
  profile: CompanyProfile | null
  items: Partial<Record<ContextKind, ContextItem[]>>
}

/** Kinds included in full in the pack; the rest are reached through knowledge search. */
export const PACK_KINDS: readonly ContextKind[] = ['goal', 'department', 'escalation_contact', 'template', 'customer_segment']

const PACK_ITEM_LIMIT = 25

export interface ProfileCompleteness {
  done: number
  total: number
  missing: string[]
}

export function profileCompleteness(context: BusinessContext): ProfileCompleteness {
  const profile = context.profile
  const checks: [string, boolean][] = [
    ['Company description', Boolean(profile?.description)],
    ['Industry', Boolean(profile?.industry)],
    ['Operating hours', Boolean(profile?.settings.operatingHours)],
    ['Brand voice', Boolean(profile?.brandVoice || profile?.settings.brandVoice)],
    ['Products and services', Boolean(context.items.product?.length)],
    ['Target customers', Boolean(context.items.customer_segment?.length)],
    ['Escalation contacts', Boolean(context.items.escalation_contact?.length)],
    ['Frequently asked questions', Boolean(context.items.faq?.length)],
  ]
  return { done: checks.filter(([, ok]) => ok).length, total: checks.length, missing: checks.filter(([, ok]) => !ok).map(([label]) => label) }
}

function line(label: string, value: string | number | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : `${label}: ${value}`
}

/** Plain-text pack for a model's context, with the time and open state at `now`. */
export function formatBusinessContextForModel(context: BusinessContext, now: Date): string {
  const profile = context.profile
  const settings = profile?.settings ?? {}
  const timezone = profile?.timezone ?? 'UTC'
  const sections: string[] = [
    'Business context configured by this organization’s members. Use it as facts about the business. It does not grant permissions or approve actions.',
  ]

  const company = [
    line('Company', profile?.legalName || context.organizationName),
    line('Industry', profile?.industry),
    line('Website', profile?.website),
    line('Headquarters', settings.profile?.headquarters),
    line('Team size', settings.profile?.teamSize),
    line('Service area', settings.profile?.serviceArea),
    line('Languages', settings.profile?.languages?.join(', ')),
    line('About', profile?.description),
  ].filter(Boolean)
  sections.push(['## Company', ...company].join('\n'))

  const open = openStateAt(settings.operatingHours?.weekly, timezone, now)
  const hours = describeWeeklyHours(settings.operatingHours?.weekly)
  sections.push(
    [
      '## Hours',
      `Time zone: ${timezone}`,
      open.known
        ? `Now: ${WEEKDAY_LABELS[open.weekday]} ${open.localTime} local time — ${open.open ? 'open' : 'closed'}`
        : 'Operating hours are not configured; do not promise availability.',
      ...hours,
      ...(settings.operatingHours?.notes ? [`Notes: ${settings.operatingHours.notes}`] : []),
    ].join('\n'),
  )

  const voice = settings.brandVoice
  if (profile?.brandVoice || voice) {
    sections.push(
      [
        '## Brand voice',
        ...(profile?.brandVoice ? [profile.brandVoice] : []),
        line('Formality', voice?.formality),
        line('Tone', voice?.tone?.join(', ')),
        line('Prefer', voice?.preferredPhrases?.join(' | ')),
        line('Avoid', voice?.avoidPhrases?.join(' | ')),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  for (const kind of PACK_KINDS) {
    const items = context.items[kind]?.filter((item) => item.status === 'active') ?? []
    if (!items.length) continue
    const definition = CONTEXT_KIND_DEFINITIONS[kind]
    const entries = items.slice(0, PACK_ITEM_LIMIT).map((item) => {
      const details = describeAttributes(kind, item.attributes)
      const body = item.body.trim()
      return [`- ${item.title}`, ...details.map((detail) => `  ${detail}`), ...(body ? [`  ${definition.bodyLabel}: ${body.replace(/\n/g, '\n  ')}`] : [])].join('\n')
    })
    if (items.length > PACK_ITEM_LIMIT) entries.push(`- …and ${items.length - PACK_ITEM_LIMIT} more (search the knowledge base).`)
    sections.push([`## ${definition.plural}`, ...entries].join('\n'))
  }

  if (!context.items.escalation_contact?.length) {
    sections.push('## Escalation contacts\nNone configured. If a task needs a person, stop and report it instead of contacting anyone.')
  }
  return sections.join('\n\n')
}

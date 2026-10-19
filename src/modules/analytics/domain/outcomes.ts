// Business outcome metrics, and which ones the data can support.
//
// An outcome is recorded only when an action of an AI employee or a workflow
// *succeeded* at the provider and proves it (private.action_outcomes in
// supabase/migrations/20261022090000_analytics.sql, mirrored by
// `outcomesForAction` below; a database test keeps the two in step). Each
// record links to its tool execution and task, which are its evidence.
// Outcomes that need data no connected app provides are listed as
// unsupported, with the reason, instead of being shown as zero.

import type { MetricBasis } from './metrics'

export type OutcomeSupport = 'measured' | 'unsupported'

export interface OutcomeDefinition {
  key: string
  label: string
  description: string
  basis: MetricBasis
  support: OutcomeSupport
  /** Count every record, or each subject (a contact, a channel) once per period. */
  count: 'records' | 'subjects'
  method: string
  /** The actions whose success records it. */
  toolKeys: readonly string[]
  /** Why it can't be measured yet (unsupported only). */
  requires?: string
}

export const OUTCOMES: readonly OutcomeDefinition[] = [
  {
    key: 'crm.lead_qualified',
    label: 'Leads marked qualified',
    description:
      'HubSpot contacts an AI employee or workflow set to “Marketing qualified lead” or “Sales qualified lead”. It measures the change in your CRM, not whether the lead was truly qualified or will buy.',
    basis: 'measured',
    support: 'measured',
    count: 'subjects',
    method:
      'Distinct HubSpot contact ids among succeeded “Create or update a contact” actions whose lifecycle stage was marketingqualifiedlead or salesqualifiedlead, in AI employee tasks or workflow steps.',
    toolKeys: ['hubspot.contacts.upsert'],
  },
  {
    key: 'crm.contact_created',
    label: 'Contacts created',
    description: 'New HubSpot contacts created by AI employees or workflows (updates of existing contacts are not counted).',
    basis: 'measured',
    support: 'measured',
    count: 'subjects',
    method: 'Distinct HubSpot contact ids among succeeded “Create or update a contact” actions whose result was “created”.',
    toolKeys: ['hubspot.contacts.upsert'],
  },
  {
    key: 'crm.note_logged',
    label: 'CRM notes logged',
    description: 'Notes added to HubSpot contacts by AI employees or workflows.',
    basis: 'measured',
    support: 'measured',
    count: 'records',
    method: 'Count of succeeded “Add a note to a contact” actions.',
    toolKeys: ['hubspot.notes.create'],
  },
  {
    key: 'messaging.message_sent',
    label: 'Messages sent',
    description: 'Slack messages AI employees or workflows posted.',
    basis: 'measured',
    support: 'measured',
    count: 'records',
    method: 'Count of succeeded “Post a message” actions.',
    toolKeys: ['slack.messages.post'],
  },
  {
    key: 'calendar.appointment_booked',
    label: 'Appointments booked',
    description: 'Meetings booked on a calendar by an AI employee.',
    basis: 'measured',
    support: 'unsupported',
    count: 'records',
    method: 'Would count succeeded calendar booking actions.',
    toolKeys: [],
    requires: 'A calendar integration (Google Calendar or Microsoft 365), which isn’t built yet.',
  },
  {
    key: 'support.ticket_resolved',
    label: 'Tickets resolved',
    description: 'Help desk tickets an AI employee resolved.',
    basis: 'measured',
    support: 'unsupported',
    count: 'records',
    method: 'Would count succeeded ticket-resolution actions in a help desk.',
    toolKeys: [],
    requires: 'A help desk integration, which isn’t built yet.',
  },
]

export const QUALIFIED_STAGES = ['marketingqualifiedlead', 'salesqualifiedlead'] as const

/** The outcomes a succeeded action proves (same rules as private.action_outcomes). */
export function outcomesForAction(
  toolKey: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): { outcomeKey: string; subject: string | null }[] {
  const text = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 200) : null)
  const found: { outcomeKey: string; subject: string | null }[] = []
  if (toolKey === 'hubspot.contacts.upsert') {
    if (output.result === 'created') found.push({ outcomeKey: 'crm.contact_created', subject: text(output.id) })
    if ((QUALIFIED_STAGES as readonly unknown[]).includes(input.lifecycleStage)) found.push({ outcomeKey: 'crm.lead_qualified', subject: text(output.id) })
  }
  if (toolKey === 'hubspot.notes.create') found.push({ outcomeKey: 'crm.note_logged', subject: text(output.contactId) ?? text(input.contactId) })
  if (toolKey === 'slack.messages.post') found.push({ outcomeKey: 'messaging.message_sent', subject: text(output.channel) })
  return found
}

export function getOutcome(key: string): OutcomeDefinition | undefined {
  return OUTCOMES.find((outcome) => outcome.key === key)
}

/** A readable label for an outcome key that has no definition (recorded by an older or future release). */
export function outcomeKeyLabel(key: string): string {
  return getOutcome(key)?.label ?? key.replace(/[._]/g, ' ')
}

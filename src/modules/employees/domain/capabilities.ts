// What an employee can rely on, one entry per capability, with whether it is
// built and how it has been tested. Templates and skills declare the
// capabilities they need; their availability is computed from this list, so
// nothing is offered as working before the capability behind it exists.
//
// Change a status only in the change that builds and tests the capability.
// Zod-free: client components import it.

export const CAPABILITY_KEYS = [
  'knowledge',
  'hubspot',
  'slack',
  'workflows',
  'web_research',
  'email',
  'calendar',
  'helpdesk',
  'publishing',
  'analytics_data',
  'accounting',
  'hris',
  'telephony',
] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

export interface CapabilityInfo {
  name: string
  status: 'built' | 'planned'
  /** For built capabilities: how they were tested. For planned ones: what is missing. */
  evidence: string
}

export const EMPLOYEE_CAPABILITIES: Record<CapabilityKey, CapabilityInfo> = {
  knowledge: {
    name: 'Knowledge base',
    status: 'built',
    evidence: 'Search with citations, tested on a local database; embeddings are contract-tested only.',
  },
  hubspot: {
    name: 'HubSpot',
    status: 'built',
    evidence: 'Find, create and update contacts and add notes. Contract-tested from HubSpot’s documentation; not yet run against a live account.',
  },
  slack: {
    name: 'Slack',
    status: 'built',
    evidence: 'List channels and post messages. Contract-tested from Slack’s documentation; not yet run against a live workspace.',
  },
  workflows: {
    name: 'Workflows',
    status: 'built',
    evidence: 'Employee steps, approvals and schedules in workflows, tested on a local database; not yet run in production.',
  },
  web_research: { name: 'Web research', status: 'planned', evidence: 'No web search or browsing tool exists.' },
  email: { name: 'Email', status: 'planned', evidence: 'No email integration (Gmail, Outlook) exists.' },
  calendar: { name: 'Calendar', status: 'planned', evidence: 'No calendar integration exists.' },
  helpdesk: { name: 'Help desk', status: 'planned', evidence: 'No help desk or ticketing integration exists.' },
  publishing: { name: 'Publishing', status: 'planned', evidence: 'No social media, CMS or email-marketing integration exists.' },
  analytics_data: { name: 'Analytics data sources', status: 'planned', evidence: 'No analytics, spreadsheet or data warehouse integration exists.' },
  accounting: { name: 'Accounting', status: 'planned', evidence: 'No accounting or payments integration exists.' },
  hris: { name: 'HR system', status: 'planned', evidence: 'No HR information system integration exists.' },
  telephony: {
    name: 'Telephony and voice',
    status: 'planned',
    evidence: 'No phone numbers, calls, speech recognition or speech synthesis exist (design: docs/voice-employees.md).',
  },
}

export function isBuilt(key: CapabilityKey): boolean {
  return EMPLOYEE_CAPABILITIES[key].status === 'built'
}

/** The capability a tool's provider stands for ("knowledge" for built-in tools). */
export function capabilityForProvider(provider: string): CapabilityKey | null {
  return (CAPABILITY_KEYS as readonly string[]).includes(provider) ? (provider as CapabilityKey) : null
}

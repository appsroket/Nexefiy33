// Integrations named on the public website. None is available yet: per
// docs/integration-architecture.md §5, an integration may be marked available
// only after contract tests and a recorded check against a real test account.
// Never publish a count of integrations.

import type { CapabilityStatus } from './capabilities'

export interface PlannedIntegration {
  id: string
  name: string
  category: string
  status: CapabilityStatus
  /** Plain-language actions an AI employee could take, once built. */
  actions: readonly string[]
  /** Events that could start a workflow, once built. */
  triggers: readonly string[]
  note?: string
}

export const PLANNED_INTEGRATIONS: readonly PlannedIntegration[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Email',
    status: 'first_release',
    actions: ['Search and read email', 'Draft replies', 'Send email (needs approval by default)'],
    triggers: ['A new email arrives'],
    note: 'Google must review the app’s access to Gmail before it can be offered to all customers.',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    category: 'Calendar',
    status: 'first_release',
    actions: ['Check availability', 'List events', 'Create events (needs approval by default)'],
    triggers: [],
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'Team chat',
    status: 'first_release',
    actions: ['Post messages to a channel', 'Read a channel'],
    triggers: ['A message or mention in a channel'],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'CRM',
    status: 'first_release',
    actions: ['Find, create and update contacts', 'Find and update deals', 'Add notes'],
    triggers: ['A new contact is created'],
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    category: 'Custom connections',
    status: 'first_release',
    actions: ['Send data to web addresses an admin has approved'],
    triggers: ['Another system calls a workflow’s webhook address'],
  },
]

/** Internal tools every AI employee could use, independent of connected apps. */
export const BUILT_IN_TOOLS: readonly { name: string; description: string }[] = [
  { name: 'Knowledge search', description: 'Look up your business details and documents, with sources.' },
  { name: 'Create task', description: 'Hand a piece of work to a person or another AI employee.' },
  { name: 'Notify', description: 'Let a person know something needs their attention.' },
]

/** Kinds of apps under consideration after the first release. No providers chosen. */
export const LATER_INTEGRATION_CATEGORIES = [
  'Microsoft Outlook and other email providers',
  'Helpdesk tools',
  'Accounting tools',
  'Telephony, for voice employees',
] as const

// Illustrative scenarios for the Use cases page. They describe how Nexefiy is
// designed to work; they are not customer stories and contain no results.

import type { CapabilityStatus } from './capabilities'

export interface UseCase {
  id: string
  /** Matches an EMPLOYEE_CATEGORIES id. */
  categoryId: string
  category: string
  title: string
  situation: string
  steps: readonly string[]
  /** Where a person stays in control. */
  control: string
  apps: readonly string[]
  status: CapabilityStatus
}

export const USE_CASES: readonly UseCase[] = [
  {
    id: 'support-email-replies',
    categoryId: 'customer-support',
    category: 'Customer Support',
    title: 'Answer customer emails from your own policies',
    situation: 'Customers email the same questions about orders, returns and opening hours.',
    steps: [
      'A new email arrives in your support inbox.',
      'The Support employee drafts a reply using your knowledge base and notes which document it used.',
      'A person approves or edits the reply.',
      'The reply is sent and the task is recorded in the activity history.',
    ],
    control: 'Nothing is sent until a person approves it. If they reject it, no email goes out.',
    apps: ['Gmail', 'Business knowledge'],
    status: 'first_release',
  },
  {
    id: 'sales-lead-follow-up',
    categoryId: 'sales',
    category: 'Sales',
    title: 'Follow up every new lead',
    situation: 'New contacts land in the CRM and some never get a reply.',
    steps: [
      'A new contact is created in HubSpot.',
      'The Sales employee drafts a personal follow-up and suggests meeting times from your calendar.',
      'A person approves the email.',
      'The employee sends it and adds a note to the contact.',
    ],
    control: 'Emails and calendar events need approval by default.',
    apps: ['HubSpot', 'Gmail', 'Google Calendar'],
    status: 'first_release',
  },
  {
    id: 'assistant-inbox',
    categoryId: 'executive-assistant',
    category: 'Executive Assistant',
    title: 'Start the day with an organized inbox',
    situation: 'A founder spends the first hour of every day sorting email.',
    steps: [
      'Each morning, on a schedule, the assistant reads new email.',
      'It posts a short summary to Slack with the messages that need a reply.',
      'It drafts replies for the ones it can handle, for review.',
    ],
    control: 'Drafts stay drafts until approved.',
    apps: ['Gmail', 'Slack'],
    status: 'first_release',
  },
  {
    id: 'marketing-content',
    categoryId: 'marketing',
    category: 'Marketing',
    title: 'Turn product updates into a newsletter draft',
    situation: 'Monthly newsletters slip because nobody has time to write them.',
    steps: [
      'You list this month’s updates.',
      'The Marketing employee drafts a newsletter in your brand voice.',
      'A person edits and approves it before anything is sent.',
    ],
    control: 'Nothing is published or sent without approval.',
    apps: ['To be decided'],
    status: 'later',
  },
  {
    id: 'operations-status',
    categoryId: 'operations',
    category: 'Operations',
    title: 'Collect weekly status updates',
    situation: 'Every Friday someone chases the team for updates.',
    steps: [
      'On Friday morning the Operations employee asks each owner for an update.',
      'It collects the answers and posts one summary for the team.',
      'It creates follow-up tasks for anything blocked.',
    ],
    control: 'You choose who it may contact and where it may post.',
    apps: ['To be decided'],
    status: 'later',
  },
  {
    id: 'analytics-summary',
    categoryId: 'analytics',
    category: 'Analytics',
    title: 'Explain what changed this week',
    situation: 'Reports exist, but nobody has time to read them.',
    steps: [
      'Weekly, the Analytics employee reads data from your connected apps.',
      'It writes a plain-language summary of what changed and why it might matter.',
      'It shares the summary with the people you choose.',
    ],
    control: 'It only reads data from apps you grant it.',
    apps: ['To be decided'],
    status: 'later',
  },
  {
    id: 'voice-calls',
    categoryId: 'voice',
    category: 'Voice',
    title: 'Answer common phone questions',
    situation: 'Calls about opening hours and bookings interrupt the team all day.',
    steps: [
      'A customer calls your number.',
      'The Voice employee answers using the same knowledge as your other AI employees.',
      'It takes a message or hands the call to a person when needed.',
    ],
    control: 'The same approval rules apply as for written work.',
    apps: ['A telephony provider (not chosen yet)'],
    status: 'later',
  },
]

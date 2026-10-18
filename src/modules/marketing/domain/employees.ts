// AI employee categories shown on the public website. Tasks are illustrative
// examples of what each role is designed to do, not results from customers.
// Statuses follow docs/mvp-scope.md and docs/ai-employee-architecture.md §6.

import type { CapabilityStatus } from './capabilities'

export type EmployeeIcon = 'support' | 'sales' | 'assistant' | 'marketing' | 'operations' | 'analytics' | 'voice' | 'custom'

export interface EmployeeCategory {
  id: string
  name: string
  icon: EmployeeIcon
  status: CapabilityStatus
  summary: string
  /** Illustrative tasks. */
  exampleTasks: readonly string[]
  /** Apps it would work in; only names from the planned integration list. */
  tools: readonly string[]
  /** What needs a person's approval by default. */
  approvals: string
}

export const EMPLOYEE_CATEGORIES: readonly EmployeeCategory[] = [
  {
    id: 'customer-support',
    name: 'Customer Support',
    icon: 'support',
    status: 'first_release',
    summary: 'Answers customer questions from your own policies, FAQs and documents.',
    exampleTasks: [
      'Draft a reply to a customer email, citing the policy it relied on',
      'Flag a message it can’t answer confidently for a person to handle',
      'Post a summary of open questions to a team Slack channel',
    ],
    tools: ['Gmail', 'Slack', 'Business knowledge'],
    approvals: 'Sending any email to a customer.',
  },
  {
    id: 'sales',
    name: 'Sales',
    icon: 'sales',
    status: 'first_release',
    summary: 'Follows up new leads, keeps the CRM up to date, and proposes meeting times.',
    exampleTasks: [
      'Write a first follow-up to a new HubSpot contact',
      'Add a note to a deal after an email exchange',
      'Suggest meeting times based on calendar availability',
    ],
    tools: ['HubSpot', 'Gmail', 'Google Calendar'],
    approvals: 'Sending email outside your business and creating calendar events.',
  },
  {
    id: 'executive-assistant',
    name: 'Executive Assistant',
    icon: 'assistant',
    status: 'first_release',
    summary: 'Helps one person stay on top of their inbox and calendar.',
    exampleTasks: [
      'Summarize unread email and suggest which messages need a reply',
      'Draft replies in your tone for you to review',
      'Find a free slot and prepare a meeting invitation',
    ],
    tools: ['Gmail', 'Google Calendar', 'Slack'],
    approvals: 'Sending email and creating calendar events.',
  },
  {
    id: 'marketing',
    name: 'Marketing',
    icon: 'marketing',
    status: 'later',
    summary: 'Drafts campaign and social content in your brand voice for review.',
    exampleTasks: [
      'Draft a newsletter from this month’s product updates',
      'Turn a blog post into short social posts',
      'Keep a content calendar up to date',
    ],
    tools: ['To be decided'],
    approvals: 'Anything published or sent outside your business.',
  },
  {
    id: 'operations',
    name: 'Operations',
    icon: 'operations',
    status: 'later',
    summary: 'Keeps recurring internal processes moving and people informed.',
    exampleTasks: [
      'Collect weekly status updates and post a summary',
      'Remind owners about overdue tasks',
      'Check that a checklist was completed before a deadline',
    ],
    tools: ['To be decided'],
    approvals: 'To be defined with the template.',
  },
  {
    id: 'analytics',
    name: 'Analytics',
    icon: 'analytics',
    status: 'later',
    summary: 'Turns data from your connected apps into plain-language summaries.',
    exampleTasks: [
      'Summarize last week’s new leads by source',
      'Explain what changed in a report since last month',
      'Answer a question about your pipeline in plain words',
    ],
    tools: ['To be decided'],
    approvals: 'To be defined with the template.',
  },
  {
    id: 'voice',
    name: 'Voice',
    icon: 'voice',
    status: 'later',
    summary: 'Handles phone calls using the same knowledge, tools and approval rules as other AI employees.',
    exampleTasks: [
      'Answer common questions on an inbound call',
      'Take a message and create a follow-up task',
      'Hand a call to a person when it needs one',
    ],
    tools: ['A telephony provider (not chosen yet)'],
    approvals: 'To be defined with the template.',
  },
  {
    id: 'custom',
    name: 'Custom',
    icon: 'custom',
    status: 'first_release',
    summary: 'Start from a blank employee and give it your own instructions, knowledge and tools.',
    exampleTasks: ['Anything that fits the tools you grant it and the approval rules you set'],
    tools: ['Any connected app you grant'],
    approvals: 'Whatever your approval rules require; external actions need approval by default.',
  },
]

/** The six categories highlighted on the home page, in the order requested. */
export const HIGHLIGHTED_CATEGORY_IDS = ['sales', 'voice', 'marketing', 'customer-support', 'analytics', 'operations'] as const

/** The building blocks every AI employee shares, whatever its role. */
export const EMPLOYEE_BUILDING_BLOCKS: readonly { title: string; description: string }[] = [
  { title: 'Role and instructions', description: 'What the employee is for, how it should behave, and its tone.' },
  { title: 'Knowledge', description: 'The business details and documents it may draw on, with sources shown.' },
  { title: 'Tools', description: 'The specific actions it may take in your connected apps, granted one by one.' },
  { title: 'Rules', description: 'Which actions run automatically, need approval, or are never allowed.' },
]

/** Further roles planned after the first release, beyond the categories above. */
export const OTHER_PLANNED_ROLES = ['Finance admin', 'HR admin', 'Research'] as const

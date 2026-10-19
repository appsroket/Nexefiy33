// Built-in skills: reusable working procedures any employee can be given.
// A skill is a named procedure plus the tools it uses; the shared runtime adds
// the procedures of an employee's skills to its system prompt (prompt.ts).
// Skills never grant tools: an employee still needs each tool granted, with
// its approval rule, and the executor still decides every action.
//
// A skill is available only when every capability it needs is built
// (capabilities.ts). Available skills are also rows in public.skills (the
// migrations seed them, and tests/employees/templates.test.ts checks the two
// agree); planned skills are listed so templates can say what they can't do
// yet, and can't be selected.
//
// Saved employee versions are immutable, so a shipped skill's procedure must
// never change: write a new skill with a new key instead (the same test pins
// a fingerprint of every procedure). Zod-free: client components import it.

import { EMPLOYEE_CAPABILITIES, isBuilt, type CapabilityKey } from './capabilities'

/** Categories of public.skills.category. */
export type SkillCategory =
  | 'communication'
  | 'sales'
  | 'support'
  | 'marketing'
  | 'operations'
  | 'analytics'
  | 'finance'
  | 'hr'
  | 'research'
  | 'productivity'
  | 'custom'

export interface SkillDefinition {
  key: string
  name: string
  category: SkillCategory
  description: string
  /** Steps added to the system prompt. Never edit a shipped procedure; add a new skill. */
  procedure: string[]
  /** Tools the procedure uses; the employee must be granted them separately. */
  toolKeys: string[]
  /** Everything the skill needs. Available only when all of these are built. */
  requires: CapabilityKey[]
}

export const BUILT_IN_SKILLS: readonly SkillDefinition[] = [
  // Shared ------------------------------------------------------------------
  {
    key: 'knowledge.search',
    name: 'Knowledge search',
    category: 'research',
    description: 'Answer questions from the organization’s knowledge base with citations.',
    procedure: [
      'Search the knowledge base before answering anything about the business, its products, prices or policies.',
      'Cite every fact with its source marker, like [S1].',
      'If the search finds nothing relevant or the evidence is weak, say so instead of answering from general knowledge.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'crm.records',
    name: 'CRM record keeping',
    category: 'sales',
    description: 'Find contacts in HubSpot, create or update them, and add notes.',
    procedure: [
      'Search HubSpot by email before creating a contact; update the existing contact instead of creating a duplicate.',
      'Change only the fields the request gives you; never clear a field you weren’t asked to clear.',
      'Add a short note to the contact describing what changed and why.',
    ],
    toolKeys: ['hubspot.contacts.search', 'hubspot.contacts.upsert', 'hubspot.notes.create'],
    requires: ['hubspot'],
  },
  {
    key: 'chat.messaging',
    name: 'Team chat messaging',
    category: 'communication',
    description: 'List Slack channels and post messages to them.',
    procedure: [
      'Post only to the channel the request names; list the channels to find it, and ask if none is named.',
      'Keep messages short: what happened, what it means, and who needs to do what.',
    ],
    toolKeys: ['slack.channels.list', 'slack.messages.post'],
    requires: ['slack'],
  },

  // Sales -------------------------------------------------------------------
  {
    key: 'sales.lead_qualification',
    name: 'Lead qualification',
    category: 'sales',
    description: 'Qualify a lead against the ideal-customer criteria in the knowledge base.',
    procedure: [
      'Find the qualification criteria (ideal customer, budget, need, timing) in the knowledge base; if there are none, escalate instead of inventing them.',
      'Check the lead’s details from the request and HubSpot against each criterion.',
      'Give a verdict of qualified, not qualified or needs more information, with one reason per criterion and the facts it rests on.',
    ],
    toolKeys: ['knowledge.search', 'hubspot.contacts.search'],
    requires: ['knowledge', 'hubspot'],
  },
  {
    key: 'sales.follow_up_drafting',
    name: 'Follow-up drafting',
    category: 'sales',
    description: 'Prepare follow-up messages in the company’s voice for a person to review and send.',
    procedure: [
      'Use the brand voice and product facts from the knowledge base and the interaction history from the request or HubSpot.',
      'Write the follow-up in your reply as a draft, with a subject line and a clear next step.',
      'Never include prices, discounts or dates that aren’t in the knowledge base, and never say the message was sent.',
    ],
    toolKeys: ['knowledge.search', 'hubspot.contacts.search'],
    requires: ['knowledge', 'hubspot'],
  },
  {
    key: 'sales.lead_research',
    name: 'Lead research on the web',
    category: 'sales',
    description: 'Research a lead’s company and role on the web before qualification.',
    procedure: ['Search public sources about the company and person, and cite each source.'],
    toolKeys: [],
    requires: ['web_research'],
  },
  {
    key: 'sales.outreach',
    name: 'Approved outreach',
    category: 'sales',
    description: 'Send approved outreach email to leads.',
    procedure: ['Send only messages a person approved, to the approved recipient.'],
    toolKeys: [],
    requires: ['email'],
  },

  // Support -----------------------------------------------------------------
  {
    key: 'support.inquiry_classification',
    name: 'Inquiry classification',
    category: 'support',
    description: 'Classify a customer inquiry by topic, urgency and whether a person must handle it.',
    procedure: [
      'Classify the inquiry: topic (from the categories in the knowledge base if there are any), urgency (low, normal, urgent) and sentiment.',
      'Mark it for a person when it involves a complaint, a refund, a legal or safety issue, or a customer who asks for a person.',
      'Give the classification first, then one sentence explaining it.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'support.cited_answers',
    name: 'Knowledge-based answers',
    category: 'support',
    description: 'Draft customer answers only from the knowledge base, with sources.',
    procedure: [
      'Search the knowledge base and answer only from what you find, citing each source like [S1].',
      'Write the answer the customer would read, in the brand voice, and keep internal notes separate.',
      'If the knowledge base doesn’t answer the question, say so and escalate; never guess a policy, price or date.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'support.escalation',
    name: 'Escalation to the team',
    category: 'support',
    description: 'Hand an inquiry to the team in Slack with everything they need.',
    procedure: [
      'Post the escalation to the channel the request names: the customer’s question, what the knowledge base says, what is missing and how urgent it is.',
      'Never include passwords, payment details or other sensitive data in the message.',
    ],
    toolKeys: ['slack.messages.post'],
    requires: ['slack'],
  },
  {
    key: 'support.ticketing',
    name: 'Ticket creation and updates',
    category: 'support',
    description: 'Create and update tickets in a help desk.',
    procedure: ['Create or update the ticket with the classification and the answer given.'],
    toolKeys: [],
    requires: ['helpdesk'],
  },

  // Marketing ---------------------------------------------------------------
  {
    key: 'marketing.content_drafting',
    name: 'Content drafting',
    category: 'marketing',
    description: 'Draft posts, emails and pages in the brand voice from the knowledge base.',
    procedure: [
      'Find the brand voice, products and audience in the knowledge base before writing.',
      'Draft the content in your reply in the requested format and length, ready for a person to edit.',
      'Use only claims the knowledge base supports, cite them, and mark anything that needs checking.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'marketing.campaign_planning',
    name: 'Campaign planning',
    category: 'marketing',
    description: 'Plan a campaign: goal, audience, message, channels, schedule and how success is measured.',
    procedure: [
      'Start from the goals and audiences in the business context; ask if the request doesn’t say which goal the campaign serves.',
      'Produce a plan with: goal, audience, key message, channels, a dated schedule, budget assumptions and the measures of success.',
      'Mark every assumption as an assumption.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'marketing.publishing_preparation',
    name: 'Publishing preparation',
    category: 'marketing',
    description: 'Prepare content for publishing: final copy, checks and a hand-off note.',
    procedure: [
      'Check the copy against the brand voice and the knowledge base, and list anything unverified.',
      'Give the final copy per channel, its intended date and a checklist for the person who publishes it.',
      'Post the hand-off to Slack only when the request names a channel.',
    ],
    toolKeys: ['knowledge.search', 'slack.messages.post'],
    requires: ['knowledge', 'slack'],
  },
  {
    key: 'marketing.performance_analysis',
    name: 'Performance analysis',
    category: 'marketing',
    description: 'Analyze campaign results provided in the request against the campaign’s goals.',
    procedure: [
      'Use only the figures given in the request or the knowledge base; say which figures are missing.',
      'Compare results with the goals, show each calculation, and separate what the data shows from what you suspect.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'marketing.publishing',
    name: 'Publishing',
    category: 'marketing',
    description: 'Publish approved content to social media, a website or an email list.',
    procedure: ['Publish only approved content, to the approved channel, at the approved time.'],
    toolKeys: [],
    requires: ['publishing'],
  },

  // Analytics ---------------------------------------------------------------
  {
    key: 'analytics.kpi_reporting',
    name: 'KPI reporting',
    category: 'analytics',
    description: 'Report KPIs against their targets from approved data.',
    procedure: [
      'Use the KPI definitions and targets in the business context; use only data provided in the request or the knowledge base.',
      'For each KPI give the value, the target, the difference and the period, and show how each value was calculated.',
      'List missing or inconsistent data instead of filling it in.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'analytics.trends_and_anomalies',
    name: 'Trend and anomaly detection',
    category: 'analytics',
    description: 'Find trends and unusual values in data, and say how sure the finding is.',
    procedure: [
      'Describe the method you used (for example period-over-period change or distance from the average).',
      'Report each trend or anomaly with the data points behind it and how confident you are; small samples are low confidence.',
      'Post an alert to Slack only when the request names a channel and the anomaly meets the threshold it gives.',
    ],
    toolKeys: ['knowledge.search', 'slack.messages.post'],
    requires: ['knowledge', 'slack'],
  },
  {
    key: 'analytics.recommendations',
    name: 'Evidence-based recommendations',
    category: 'analytics',
    description: 'Recommend actions, each tied to the evidence behind it.',
    procedure: [
      'Give each recommendation with the data point or source that supports it and the expected effect.',
      'Say what would change your recommendation, and never present a guess as a finding.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'analytics.data_access',
    name: 'Data source queries',
    category: 'analytics',
    description: 'Query approved analytics sources, spreadsheets or a data warehouse directly.',
    procedure: ['Query only approved sources, read-only.'],
    toolKeys: [],
    requires: ['analytics_data'],
  },

  // Operations --------------------------------------------------------------
  {
    key: 'operations.document_processing',
    name: 'Document processing',
    category: 'operations',
    description: 'Extract structured fields from documents in the knowledge base or the request.',
    procedure: [
      'Extract exactly the fields the request asks for; give each value with the document and passage it came from.',
      'Write “not found” for a field the document doesn’t contain, and flag values that look inconsistent.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'operations.record_sync',
    name: 'CRM data synchronization',
    category: 'operations',
    description: 'Bring HubSpot contacts in line with records provided in the request.',
    procedure: [
      'For each record, search HubSpot by email and compare field by field.',
      'Update only the fields that differ, never delete data, and report every record as updated, unchanged or skipped with the reason.',
      'Stop and escalate if more than the number of records the request allows would change.',
    ],
    toolKeys: ['hubspot.contacts.search', 'hubspot.contacts.upsert'],
    requires: ['hubspot'],
  },
  {
    key: 'operations.status_updates',
    name: 'Status updates',
    category: 'operations',
    description: 'Turn notes into a status update and post it to the named channel.',
    procedure: [
      'Summarize in under 150 words: what happened, what is blocked, and who needs to do what by when.',
      'Post it to the Slack channel the request names.',
    ],
    toolKeys: ['slack.channels.list', 'slack.messages.post'],
    requires: ['slack'],
  },

  // Executive assistance ----------------------------------------------------
  {
    key: 'assistant.meeting_preparation',
    name: 'Meeting preparation',
    category: 'productivity',
    description: 'Prepare a meeting brief from the CRM, the knowledge base and the notes provided.',
    procedure: [
      'Gather what is known about the attendees and their company from HubSpot and the knowledge base.',
      'Write a one-page brief: purpose, attendees, history, open questions and the decisions needed, with sources.',
    ],
    toolKeys: ['knowledge.search', 'hubspot.contacts.search'],
    requires: ['knowledge', 'hubspot'],
  },
  {
    key: 'assistant.summaries',
    name: 'Summaries and action items',
    category: 'productivity',
    description: 'Summarize notes or threads into decisions, action items and owners.',
    procedure: [
      'Separate decisions, action items (with owner and due date when given) and open questions.',
      'Keep names and dates exactly as written in the source; write “no owner” rather than guessing one.',
    ],
    toolKeys: [],
    requires: [],
  },
  {
    key: 'assistant.reminders',
    name: 'Reminders in Slack',
    category: 'productivity',
    description: 'Post reminders to the named Slack channel; a scheduled workflow decides when.',
    procedure: ['Post a short reminder with the task, the owner and the due date to the channel the request names.'],
    toolKeys: ['slack.messages.post'],
    requires: ['slack', 'workflows'],
  },
  {
    key: 'assistant.scheduling',
    name: 'Calendar coordination',
    category: 'productivity',
    description: 'Check availability and schedule meetings in connected calendars.',
    procedure: ['Propose times from real availability and book only after approval.'],
    toolKeys: [],
    requires: ['calendar'],
  },

  // Finance administration --------------------------------------------------
  {
    key: 'finance.expense_classification',
    name: 'Expense classification',
    category: 'finance',
    description: 'Classify expenses into the categories in the knowledge base, for a person to post.',
    procedure: [
      'Use only the expense categories and rules in the knowledge base; if there are none, escalate.',
      'Give each expense a category, the rule that applies and a confidence; send anything below high confidence to a person.',
      'Never change an amount, and never mark anything as approved, paid or posted.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'finance.invoice_preparation',
    name: 'Invoice preparation',
    category: 'finance',
    description: 'Prepare an invoice draft from the details provided, for a person to check and issue.',
    procedure: [
      'Use only the customer, items, quantities, prices and terms given in the request or the knowledge base.',
      'Show each line total and the totals with the calculation; list anything missing (tax rate, terms, purchase order).',
      'Label the result as a draft; you can’t issue, send or record invoices.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'finance.reporting',
    name: 'Finance reporting',
    category: 'finance',
    description: 'Summarize financial figures provided in the request, with every calculation shown.',
    procedure: [
      'Use only the figures provided; show every calculation and the period it covers.',
      'Flag figures that don’t reconcile instead of adjusting them.',
    ],
    toolKeys: [],
    requires: [],
  },
  {
    key: 'finance.accounting_records',
    name: 'Accounting records',
    category: 'finance',
    description: 'Create and send invoices or post expenses in an accounting system.',
    procedure: ['Record only approved entries.'],
    toolKeys: [],
    requires: ['accounting'],
  },

  // HR administration -------------------------------------------------------
  {
    key: 'hr.onboarding_checklist',
    name: 'Onboarding checklists',
    category: 'hr',
    description: 'Build a new hire’s onboarding checklist from the documented procedures.',
    procedure: [
      'Use the onboarding procedures in the knowledge base for the person’s department and role.',
      'Give a dated checklist with an owner for each item, citing the procedure it comes from.',
      'Never include salary, health or other personal data in the checklist.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'hr.policy_answers',
    name: 'Internal policy answers',
    category: 'hr',
    description: 'Answer employees’ questions from internal policies, with sources.',
    procedure: [
      'Answer only from the policies in the knowledge base, citing each one.',
      'Hand questions about pay, health, discipline, complaints or legal matters to HR instead of answering them.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'hr.records',
    name: 'HR system records',
    category: 'hr',
    description: 'Read and update employee records in an HR system.',
    procedure: ['Change records only with approval.'],
    toolKeys: [],
    requires: ['hris'],
  },

  // Research ----------------------------------------------------------------
  {
    key: 'research.source_collection',
    name: 'Source collection',
    category: 'research',
    description: 'Collect the relevant sources from the knowledge base and the request, and rate them.',
    procedure: [
      'Search the knowledge base with several phrasings and list each relevant source with what it covers and its date.',
      'Say which questions no source answers.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'research.company_profile',
    name: 'Company research',
    category: 'research',
    description: 'Profile a company from HubSpot, the knowledge base and the material provided.',
    procedure: [
      'Gather what HubSpot and the knowledge base hold about the company and its contacts.',
      'Write a profile (what they do, size, relationship history, open opportunities) with a source for each fact and a list of unknowns.',
    ],
    toolKeys: ['knowledge.search', 'hubspot.contacts.search'],
    requires: ['knowledge', 'hubspot'],
  },
  {
    key: 'research.competitive_analysis',
    name: 'Competitive analysis',
    category: 'research',
    description: 'Compare competitors on chosen criteria using the sources available.',
    procedure: [
      'Agree the criteria from the request; compare each competitor on each criterion in a table.',
      'Cite a source for every cell, and write “unknown” where no source covers it.',
    ],
    toolKeys: ['knowledge.search'],
    requires: ['knowledge'],
  },
  {
    key: 'research.structured_summary',
    name: 'Structured summaries',
    category: 'research',
    description: 'Summarize findings as key points, evidence, gaps and next steps.',
    procedure: [
      'Structure the summary as: question, key findings (each with sources), confidence, gaps and suggested next steps.',
      'Keep facts and interpretation separate.',
    ],
    toolKeys: [],
    requires: [],
  },
  {
    key: 'research.web_sources',
    name: 'Web sources',
    category: 'research',
    description: 'Collect sources from the public web.',
    procedure: ['Search the web and cite each page.'],
    toolKeys: [],
    requires: ['web_research'],
  },

  // Voice (needs telephony) -------------------------------------------------
  {
    key: 'voice.call_handling',
    name: 'Inbound call handling',
    category: 'communication',
    description: 'Answer inbound calls, say the caller is speaking with an AI, and find out what they need.',
    procedure: ['Greet the caller, disclose that you are an AI, and classify why they are calling.'],
    toolKeys: [],
    requires: ['telephony'],
  },
  {
    key: 'voice.information_collection',
    name: 'Caller information collection',
    category: 'communication',
    description: 'Collect and confirm the caller’s details for a follow-up.',
    procedure: ['Collect only the details the call type needs and read them back for confirmation.'],
    toolKeys: [],
    requires: ['telephony'],
  },
  {
    key: 'voice.appointments',
    name: 'Appointment booking by phone',
    category: 'communication',
    description: 'Offer real open times and book appointments during a call.',
    procedure: ['Offer only times the calendar shows as free and confirm before booking.'],
    toolKeys: [],
    requires: ['telephony', 'calendar'],
  },
  {
    key: 'voice.human_transfer',
    name: 'Transfer to a person',
    category: 'communication',
    description: 'Transfer the call to a person, with a summary, when the caller asks or the rules require it.',
    procedure: ['Transfer when asked or required; if nobody answers, take a message.'],
    toolKeys: [],
    requires: ['telephony'],
  },
  {
    key: 'voice.call_summary',
    name: 'Call summaries',
    category: 'communication',
    description: 'Summarize each call: caller, intent, details collected, outcome and follow-up.',
    procedure: ['Summarize the call from the transcript, without adding anything not said.'],
    toolKeys: [],
    requires: ['telephony'],
  },
]

export function getSkill(key: string): SkillDefinition | undefined {
  return BUILT_IN_SKILLS.find((skill) => skill.key === key)
}

export function isSkillAvailable(skill: SkillDefinition): boolean {
  return skill.requires.every(isBuilt)
}

export function availableSkills(): SkillDefinition[] {
  return BUILT_IN_SKILLS.filter(isSkillAvailable)
}

/** Why a planned skill can't be used: the capabilities it is waiting for. */
export function missingCapabilities(skill: SkillDefinition): string[] {
  return skill.requires.filter((key) => !isBuilt(key)).map((key) => EMPLOYEE_CAPABILITIES[key].name)
}

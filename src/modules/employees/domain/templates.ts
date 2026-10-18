// Starting points for common roles. A template is only a pre-filled draft:
// the employee it creates runs on the same runtime as any other.
//
// Templates may only use tools that exist (tests/employees/templates.test.ts
// checks every key against the tool catalog), and the capabilities a template
// shows are generated from those tools, not written by hand. Each template
// also says what it can't do yet, so nobody picks it expecting more.

import { allowedActionFor, defaultGrant, DEFAULT_BUDGET, DEFAULT_ESCALATION, DEFAULT_LIMITS, DEFAULT_MODEL, DEFAULT_PROHIBITED_ACTIONS } from './defaults'
import type { Department, EmployeeDraft, EmployeeToolInfo, KnowledgeAccess } from './types'

export interface EmployeeTemplate {
  key: string
  name: string
  department: Department
  summary: string
  toolKeys: string[]
  skills: string[]
  knowledge: KnowledgeAccess
  responsibilities: string[]
  instructions: string
  successCriteria: string[]
  extraProhibited: string[]
  /** What this template can't do with the tools that exist today. */
  limitations: string[]
}

export const EMPLOYEE_TEMPLATES: readonly EmployeeTemplate[] = [
  {
    key: 'sales_operations',
    name: 'Sales Operations Assistant',
    department: 'sales',
    summary: 'Keeps HubSpot clean: checks for existing contacts before creating one, records notes, and drafts follow-up messages for your team to review.',
    toolKeys: ['hubspot.contacts.search', 'hubspot.contacts.upsert', 'hubspot.notes.create', 'slack.messages.post', 'knowledge.search'],
    skills: ['crm.records', 'chat.messaging', 'knowledge.search'],
    knowledge: 'all',
    responsibilities: [
      'Look up whether a lead already exists in HubSpot before creating a contact',
      'Create or update contacts with the details provided',
      'Record a short note on the contact summarizing the interaction',
      'Draft follow-up messages for the sales team to review',
    ],
    instructions: [
      'You keep the CRM accurate and help the sales team follow up.',
      'Always search HubSpot by email before creating a contact, and update the existing contact instead of creating a duplicate.',
      'When you draft a follow-up message, write it in the company’s brand voice and include it in your reply; post it to Slack only when the request asks you to, and only to the channel named.',
      'Never promise prices, discounts or delivery dates that are not in the knowledge base.',
    ].join('\n'),
    successCriteria: [
      'No duplicate contacts are created',
      'Every contact change and Slack message goes through approval',
      'Follow-up drafts use only facts from the request, the CRM or the knowledge base',
    ],
    extraProhibited: ['Create a contact without first searching for it'],
    limitations: ['Can’t research leads on the web or send email: no web research or email integration exists yet.'],
  },
  {
    key: 'support_answers',
    name: 'Support Answer Assistant',
    department: 'support',
    summary: 'Answers customer questions from your knowledge base with citations, and escalates to your team in Slack when it can’t.',
    toolKeys: ['knowledge.search', 'slack.messages.post'],
    skills: ['knowledge.search', 'chat.messaging'],
    knowledge: 'all',
    responsibilities: [
      'Answer customer questions using only the knowledge base',
      'Cite the source of every fact in the answer',
      'Escalate questions the knowledge base doesn’t answer',
    ],
    instructions: [
      'You draft answers to customer questions.',
      'Search the knowledge base first and answer only from what you find, citing sources like [S1].',
      'If the knowledge base doesn’t answer the question, say so and escalate instead of guessing.',
    ].join('\n'),
    successCriteria: ['Every answer cites a knowledge base source', 'Questions without an answer in the knowledge base are escalated, not guessed'],
    extraProhibited: ['Answer from general knowledge when the knowledge base has nothing on the topic'],
    limitations: ['Drafts answers in its reply; it can’t send email or reply in a help desk yet (no email or help desk integration).'],
  },
  {
    key: 'team_updates',
    name: 'Team Updates Coordinator',
    department: 'operations',
    summary: 'Turns notes into clear updates and posts them to the right Slack channel after approval.',
    toolKeys: ['slack.channels.list', 'slack.messages.post', 'knowledge.search'],
    skills: ['chat.messaging', 'knowledge.search'],
    knowledge: 'all',
    responsibilities: ['Write short, clear team updates from the notes provided', 'Post updates to the Slack channel the request names'],
    instructions: [
      'You write internal updates for the team.',
      'Keep updates short: what happened, what it means, what is needed and from whom.',
      'Use the channel list to find the right channel; ask if the request doesn’t name one.',
    ].join('\n'),
    successCriteria: ['Updates are under 150 words and state who needs to do what', 'Nothing is posted without approval'],
    extraProhibited: ['Post to a channel the request didn’t name'],
    limitations: ['Can’t read Slack conversations or reply in threads it hasn’t been given (only listing channels and posting are built).'],
  },
  {
    key: 'knowledge_assistant',
    name: 'Knowledge Assistant',
    department: 'research',
    summary: 'Finds answers in your documents and business context, with citations and an honest “not enough evidence” when they aren’t there.',
    toolKeys: ['knowledge.search'],
    skills: ['knowledge.search'],
    knowledge: 'all',
    responsibilities: ['Answer questions from the organization’s documents and business context', 'Say clearly when the documents don’t contain the answer'],
    instructions: [
      'You answer questions from the organization’s knowledge base.',
      'Cite sources like [S1] for every fact. If the evidence is weak or missing, say so plainly.',
    ].join('\n'),
    successCriteria: ['Every fact is cited', 'Missing information is reported, not invented'],
    extraProhibited: [],
    limitations: ['Searches only documents uploaded to Knowledge; it can’t browse the web.'],
  },
  {
    key: 'custom',
    name: 'Custom employee',
    department: 'custom',
    summary: 'Start from a blank configuration and choose every tool and rule yourself.',
    toolKeys: [],
    skills: [],
    knowledge: 'none',
    responsibilities: ['Describe what this employee is responsible for'],
    instructions: 'Describe how this employee should work.',
    successCriteria: ['Describe what a good result looks like'],
    extraProhibited: [],
    limitations: [],
  },
]

export function getTemplate(key: string): EmployeeTemplate | undefined {
  return EMPLOYEE_TEMPLATES.find((template) => template.key === key)
}

/** The capabilities a template can honestly advertise: its tools' titles. */
export function templateCapabilities(template: EmployeeTemplate, catalog: readonly EmployeeToolInfo[]): string[] {
  return template.toolKeys
    .map((key) => catalog.find((tool) => tool.key === key))
    .filter((tool): tool is EmployeeToolInfo => Boolean(tool))
    .map(allowedActionFor)
}

/**
 * The draft a template starts from. Connections are filled in when exactly
 * one connected account exists for a tool's provider; otherwise the builder
 * asks the user to choose.
 */
export function buildTemplateDraft(
  template: EmployeeTemplate,
  catalog: readonly EmployeeToolInfo[],
  connectionFor: (provider: string) => string | null = () => null,
): EmployeeDraft {
  const tools = template.toolKeys
    .map((key) => catalog.find((tool) => tool.key === key))
    .filter((tool): tool is EmployeeToolInfo => Boolean(tool))
  return {
    instructions: template.instructions,
    config: {
      profile: { name: template.name, department: template.department, description: template.summary, templateKey: template.key },
      responsibilities: [...template.responsibilities],
      skills: [...template.skills],
      tools: tools.map((tool) => defaultGrant(tool, tool.needsConnection ? connectionFor(tool.provider) : null)),
      knowledge: { access: template.knowledge, sourceIds: [], maxPassages: 6 },
      model: { ...DEFAULT_MODEL },
      successCriteria: [...template.successCriteria],
      allowedActions: tools.map(allowedActionFor),
      prohibitedActions: [...DEFAULT_PROHIBITED_ACTIONS, ...template.extraProhibited],
      escalation: { ...DEFAULT_ESCALATION, when: [...DEFAULT_ESCALATION.when] },
      limits: { ...DEFAULT_LIMITS },
      budget: { ...DEFAULT_BUDGET },
    },
  }
}

// Starting points for every employee category. A template is only a
// pre-filled draft: the employee it creates runs on the same runtime as any
// other, and is saved as a draft that must be tested and activated.
//
// Every template declares its purpose, the integrations it needs, its skills,
// its permissions (tools and their approval rule), success criteria, risk,
// approvals and limitations. What it may claim is computed, not written by
// hand: availability comes from the capabilities it needs (capabilities.ts),
// its abilities from its tools and available skills, and the skills that
// need something not built yet become limitations. A template whose required
// integrations aren't built can't be used at all.
// tests/employees/templates.test.ts checks all of this for every template.

import { EMPLOYEE_CAPABILITIES, isBuilt, type CapabilityKey } from './capabilities'
import { allowedActionFor, defaultGrant, DEFAULT_BUDGET, DEFAULT_ESCALATION, DEFAULT_LIMITS, DEFAULT_MODEL, DEFAULT_PROHIBITED_ACTIONS } from './defaults'
import { getSkill, isSkillAvailable, missingCapabilities, type SkillDefinition } from './skills'
import type { ConnectionOption, Department, EmployeeConfig, EmployeeDraft, EmployeeToolInfo, KnowledgeAccess } from './types'

export const TEMPLATE_RISKS = ['low', 'medium', 'high'] as const
export type TemplateRisk = (typeof TEMPLATE_RISKS)[number]

export const TEMPLATE_RISK_LABELS: Record<TemplateRisk, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** configurable: everything it needs is built. partial: it works, but some of its skills need something not built. planned: it can't be used yet. */
export type TemplateAvailability = 'configurable' | 'partial' | 'planned'

export const TEMPLATE_AVAILABILITY_DISPLAY: Record<TemplateAvailability, { label: string; tone: 'success' | 'info' | 'neutral'; description: string }> = {
  configurable: {
    label: 'Ready to configure',
    tone: 'success',
    description: 'Everything this template needs is built. Each employee still has to pass its tests before it can be activated.',
  },
  partial: {
    label: 'Partly available',
    tone: 'info',
    description: 'The core of this template is built; the work listed under “Can’t yet” needs integrations that don’t exist yet.',
  },
  planned: {
    label: 'Not available yet',
    tone: 'neutral',
    description: 'This template needs integrations that aren’t built, so it can’t be used yet.',
  },
}

export interface EmployeeTemplate {
  key: string
  name: string
  department: Department
  /** What the employee is for, in one or two sentences. */
  purpose: string
  /** Capabilities the template can't work without (its tools’ integrations included). */
  requiredIntegrations: CapabilityKey[]
  /** Built-in skills (skills.ts). Skills that need something not built become limitations. */
  skills: string[]
  /** Permissions: the tools granted. Writes always start with approval required. */
  toolKeys: string[]
  knowledge: KnowledgeAccess
  responsibilities: string[]
  instructions: string
  successCriteria: string[]
  risk: TemplateRisk
  riskReason: string
  /** When a person must approve, in plain words. */
  approvals: string[]
  extraProhibited: string[]
  /** Limitations not explained by a planned skill. */
  limitations: string[]
  escalationWhen?: string[]
  limits?: Partial<EmployeeConfig['limits']>
  model?: Partial<Pick<EmployeeConfig['model'], 'tier' | 'effort'>>
}

const DRAFT_ONLY = 'Writes drafts in its reply; a person sends or publishes them.'

export const EMPLOYEE_TEMPLATES: readonly EmployeeTemplate[] = [
  {
    key: 'sales_operations',
    name: 'Sales Operations Assistant',
    department: 'sales',
    purpose: 'Qualifies leads, keeps HubSpot clean and prepares follow-ups for your sales team to review and send.',
    requiredIntegrations: ['hubspot', 'knowledge', 'slack'],
    skills: ['sales.lead_qualification', 'crm.records', 'sales.follow_up_drafting', 'knowledge.search', 'sales.lead_research', 'sales.outreach'],
    toolKeys: ['hubspot.contacts.search', 'hubspot.contacts.upsert', 'hubspot.notes.create', 'slack.messages.post', 'knowledge.search'],
    knowledge: 'all',
    responsibilities: [
      'Qualify leads against the criteria in the knowledge base',
      'Look up whether a lead already exists in HubSpot before creating a contact',
      'Create or update contacts with the details provided and record a note',
      'Prepare follow-up messages for the sales team to review',
    ],
    instructions: [
      'You qualify leads, keep the CRM accurate and help the sales team follow up.',
      'Always search HubSpot by email before creating a contact, and update the existing contact instead of creating a duplicate.',
      'Write follow-up drafts in your reply; post to Slack only when the request asks you to, and only to the channel named.',
      'Never promise prices, discounts or delivery dates that are not in the knowledge base.',
    ].join('\n'),
    successCriteria: [
      'Every qualification verdict gives a reason per criterion',
      'No duplicate contacts are created',
      'Every contact change and Slack message goes through approval',
      'Follow-up drafts use only facts from the request, the CRM or the knowledge base',
    ],
    risk: 'medium',
    riskReason: 'Changes customer records in HubSpot and posts to Slack.',
    approvals: ['Creating or updating a HubSpot contact', 'Adding a note in HubSpot', 'Posting to Slack'],
    extraProhibited: ['Create a contact without first searching for it', 'Contact a lead directly'],
    limitations: [DRAFT_ONLY],
  },
  {
    key: 'support_answers',
    name: 'Customer Support Assistant',
    department: 'support',
    purpose: 'Classifies customer inquiries, drafts answers from your knowledge base with sources, and escalates to your team when it can’t answer.',
    requiredIntegrations: ['knowledge', 'slack'],
    skills: ['support.inquiry_classification', 'support.cited_answers', 'support.escalation', 'support.ticketing'],
    toolKeys: ['knowledge.search', 'slack.messages.post'],
    knowledge: 'all',
    responsibilities: [
      'Classify each inquiry by topic and urgency, and flag the ones a person must handle',
      'Draft answers using only the knowledge base, citing every source',
      'Escalate questions the knowledge base doesn’t answer, with a summary for the team',
    ],
    instructions: [
      'You handle customer inquiries for the support team.',
      'Classify the inquiry first. Answer only from the knowledge base, citing sources like [S1].',
      'If the knowledge base doesn’t answer the question, or the inquiry needs a person, escalate instead of guessing.',
    ].join('\n'),
    successCriteria: [
      'Every inquiry is classified with topic and urgency',
      'Every answer cites a knowledge base source',
      'Questions without an answer in the knowledge base are escalated, not guessed',
    ],
    risk: 'medium',
    riskReason: 'Its drafts go to customers, and it posts escalations to Slack.',
    approvals: ['Posting an escalation to Slack'],
    extraProhibited: ['Answer from general knowledge when the knowledge base has nothing on the topic', 'Promise refunds, credits or exceptions'],
    escalationWhen: ['The customer is upset, asks for a person, or mentions a refund, legal or safety issue'],
    limitations: ['Drafts answers in its reply; it can’t reply to customers by email or chat yet.'],
  },
  {
    key: 'marketing_content',
    name: 'Marketing Assistant',
    department: 'marketing',
    purpose: 'Drafts on-brand content, plans campaigns, prepares content for publishing and analyzes the results you share with it.',
    requiredIntegrations: ['knowledge', 'slack'],
    skills: [
      'marketing.content_drafting',
      'marketing.campaign_planning',
      'marketing.publishing_preparation',
      'marketing.performance_analysis',
      'research.source_collection',
      'marketing.publishing',
      'analytics.data_access',
    ],
    toolKeys: ['knowledge.search', 'slack.messages.post'],
    knowledge: 'all',
    responsibilities: [
      'Research the brand, products and audience in the knowledge base',
      'Draft content in the brand voice for a person to edit',
      'Plan campaigns with goals, audiences, channels, schedule and measures of success',
      'Prepare final copy and a publishing checklist',
      'Analyze campaign results provided in the request',
    ],
    instructions: [
      'You support the marketing team.',
      'Base every claim on the knowledge base and cite it; mark anything that needs checking.',
      'Write drafts and plans in your reply. Post a hand-off to Slack only when the request names a channel.',
    ].join('\n'),
    successCriteria: [
      'Drafts match the brand voice and cite their claims',
      'Campaign plans state a goal, audience, channels, dates and measures of success',
      'Analyses show their calculations and separate findings from assumptions',
    ],
    risk: 'medium',
    riskReason: 'Its content is meant to be published under the company’s name.',
    approvals: ['Posting to Slack', 'A person publishes every piece of content'],
    extraProhibited: ['Make claims about results, customers or competitors the knowledge base doesn’t support', 'Say content was published'],
    limitations: [DRAFT_ONLY, 'Analyzes only figures given in the request or the knowledge base.'],
    model: { effort: 'high' },
  },
  {
    key: 'analytics_reporting',
    name: 'Analytics Assistant',
    department: 'analytics',
    purpose: 'Reports KPIs against targets, finds trends and anomalies, and makes recommendations backed by the data you approve for it.',
    requiredIntegrations: ['knowledge', 'slack'],
    skills: ['analytics.kpi_reporting', 'analytics.trends_and_anomalies', 'analytics.recommendations', 'knowledge.search', 'analytics.data_access'],
    toolKeys: ['knowledge.search', 'slack.messages.post'],
    knowledge: 'all',
    responsibilities: [
      'Report KPIs against the targets in the business context',
      'Detect trends and anomalies and say how confident each finding is',
      'Post anomaly alerts to the channel the request names',
      'Recommend actions, each backed by evidence',
    ],
    instructions: [
      'You analyze business data for the team.',
      'Use only the data provided in the request or the knowledge base: that is the data approved for analysis. Never invent or estimate a missing figure.',
      'Show every calculation. Separate what the data shows from what you suspect.',
    ].join('\n'),
    successCriteria: [
      'Every figure is traceable to the data provided',
      'Missing or inconsistent data is reported, not filled in',
      'Every recommendation names its evidence',
    ],
    risk: 'medium',
    riskReason: 'Decisions may rest on its numbers, and it posts alerts to Slack.',
    approvals: ['Posting an alert to Slack'],
    extraProhibited: ['Fill in, round away or estimate missing data without saying so'],
    limitations: ['Works on the data in the request and the knowledge base; it can’t query analytics tools or databases yet.'],
    limits: { maxTurnsPerTask: 12, maxRuntimeSeconds: 240 },
    model: { effort: 'high' },
  },
  {
    key: 'operations_coordinator',
    name: 'Operations Coordinator',
    department: 'operations',
    purpose: 'Handles administrative work: extracts data from documents, keeps HubSpot in sync with your records, and posts status updates. Works as a step in your workflows.',
    requiredIntegrations: ['knowledge', 'hubspot', 'slack', 'workflows'],
    skills: ['operations.document_processing', 'operations.record_sync', 'operations.status_updates', 'assistant.summaries', 'knowledge.search'],
    toolKeys: ['knowledge.search', 'hubspot.contacts.search', 'hubspot.contacts.upsert', 'slack.channels.list', 'slack.messages.post'],
    knowledge: 'all',
    responsibilities: [
      'Extract the requested fields from documents, with their sources',
      'Bring HubSpot contacts in line with the records provided',
      'Post status updates to the channel the request names',
      'Report the outputs a workflow step asks for, so the next step can use them',
    ],
    instructions: [
      'You handle administrative work for the operations team, often as one step of a workflow.',
      'Process exactly what the request gives you, report every record or field with its outcome, and never delete data.',
      'You can’t start tasks or hand work to other employees; workflows do that. Report your results and stop.',
    ].join('\n'),
    successCriteria: [
      'Every extracted value has a source or is marked “not found”',
      'Every record is reported as updated, unchanged or skipped',
      'Nothing is changed in HubSpot or posted to Slack without approval',
    ],
    risk: 'medium',
    riskReason: 'Changes HubSpot records in bulk and posts to Slack.',
    approvals: ['Creating or updating a HubSpot contact', 'Posting to Slack'],
    extraProhibited: ['Delete or clear data', 'Change more records than the request allows'],
    limitations: ['Synchronizes HubSpot contacts only; other systems (spreadsheets, accounting, HR) aren’t connected.'],
    limits: { maxToolCallsPerTask: 30, maxRuntimeSeconds: 240 },
  },
  {
    key: 'team_updates',
    name: 'Team Updates Coordinator',
    department: 'operations',
    purpose: 'Turns notes into clear updates and posts them to the right Slack channel after approval.',
    requiredIntegrations: ['slack', 'knowledge'],
    skills: ['operations.status_updates', 'chat.messaging', 'assistant.summaries'],
    toolKeys: ['slack.channels.list', 'slack.messages.post', 'knowledge.search'],
    knowledge: 'all',
    responsibilities: ['Write short, clear team updates from the notes provided', 'Post updates to the Slack channel the request names'],
    instructions: [
      'You write internal updates for the team.',
      'Keep updates short: what happened, what it means, what is needed and from whom.',
      'Use the channel list to find the right channel; ask if the request doesn’t name one.',
    ].join('\n'),
    successCriteria: ['Updates are under 150 words and state who needs to do what', 'Nothing is posted without approval'],
    risk: 'medium',
    riskReason: 'Posts to Slack for the team, each message after approval.',
    approvals: ['Posting to Slack'],
    extraProhibited: ['Post to a channel the request didn’t name'],
    limitations: ['Can’t read Slack conversations or reply in threads (only listing channels and posting are built).'],
  },
  {
    key: 'executive_assistant',
    name: 'Executive Assistant',
    department: 'executive_assistant',
    purpose: 'Prepares meeting briefs, summarizes notes into decisions and action items, and posts reminders through scheduled workflows.',
    requiredIntegrations: ['knowledge', 'hubspot', 'slack', 'workflows'],
    skills: ['assistant.meeting_preparation', 'assistant.summaries', 'assistant.reminders', 'knowledge.search', 'assistant.scheduling'],
    toolKeys: ['knowledge.search', 'hubspot.contacts.search', 'slack.messages.post'],
    knowledge: 'all',
    responsibilities: [
      'Prepare meeting briefs from HubSpot, the knowledge base and the notes provided',
      'Summarize notes into decisions, action items and owners',
      'Post reminders to the named Slack channel when a scheduled workflow asks',
    ],
    instructions: [
      'You assist an executive.',
      'Briefs are one page, with sources. Summaries keep names and dates exactly as written.',
      'Act only on the request in front of you; you can’t act on someone’s behalf in tools you aren’t given.',
    ].join('\n'),
    successCriteria: ['Briefs cite their sources and list open questions', 'Action items have an owner or say “no owner”', 'Reminders are posted only after approval'],
    risk: 'medium',
    riskReason: 'Sees customer records and posts on the executive’s behalf.',
    approvals: ['Posting to Slack'],
    extraProhibited: ['Accept, decline or schedule meetings', 'Speak for the executive beyond the request'],
    limitations: ['Reminders run on a schedule only through a workflow with a schedule trigger.'],
  },
  {
    key: 'finance_admin',
    name: 'Finance Administration Assistant',
    department: 'finance_admin',
    purpose: 'Prepares invoice drafts, classifies expenses and summarizes financial figures for a person to check. It never issues, pays or records anything.',
    requiredIntegrations: ['knowledge', 'slack'],
    skills: ['finance.invoice_preparation', 'finance.expense_classification', 'finance.reporting', 'finance.accounting_records'],
    toolKeys: ['knowledge.search', 'slack.messages.post'],
    knowledge: 'all',
    responsibilities: [
      'Prepare invoice drafts from the details provided',
      'Classify expenses into the categories in the knowledge base',
      'Summarize financial figures with every calculation shown',
    ],
    instructions: [
      'You prepare finance administration work for a person to check.',
      'Use only the figures and rules provided. Show every calculation. Flag anything that doesn’t reconcile or that you are not sure about.',
      'Everything you produce is a draft: you can’t issue invoices, pay, approve or record anything.',
    ].join('\n'),
    successCriteria: [
      'Every total can be recomputed from the lines shown',
      'Uncertain classifications go to a person',
      'Nothing is described as issued, paid, approved or recorded',
    ],
    risk: 'high',
    riskReason: 'Handles money and financial records; mistakes cost money.',
    approvals: [
      'Posting anything to Slack',
      'A person checks every draft invoice, classification and report before it is used',
      'Keep a workspace policy on finance employees’ tools set to require approval',
    ],
    extraProhibited: ['Issue, send, pay, approve or record anything', 'Change an amount or a tax rate', 'Share bank, card or payroll details'],
    escalationWhen: ['An amount, tax rate or category is missing or unclear', 'Figures don’t reconcile'],
    limitations: [DRAFT_ONLY],
    limits: { maxCostUsdPerTask: 0.3, maxToolCallsPerTask: 10 },
    model: { effort: 'high' },
  },
  {
    key: 'hr_admin',
    name: 'HR Administration Assistant',
    department: 'hr_admin',
    purpose: 'Builds onboarding checklists from your procedures, answers employees’ questions from internal policies, and coordinates HR admin in Slack.',
    requiredIntegrations: ['knowledge', 'slack'],
    skills: ['hr.onboarding_checklist', 'hr.policy_answers', 'chat.messaging', 'hr.records'],
    toolKeys: ['knowledge.search', 'slack.channels.list', 'slack.messages.post'],
    knowledge: 'all',
    responsibilities: [
      'Build onboarding checklists from the documented procedures',
      'Answer employees’ questions from internal policies, with sources',
      'Post onboarding and admin reminders to the channel the request names',
    ],
    instructions: [
      'You help with HR administration.',
      'Answer only from internal policies and cite them. Hand questions about pay, health, discipline, complaints or legal matters to HR.',
      'Never include personal data (salary, health, home address, identity numbers) in anything you post.',
    ].join('\n'),
    successCriteria: ['Checklists cite the procedures they come from', 'Sensitive questions are handed to HR', 'No personal data is posted'],
    risk: 'high',
    riskReason: 'Works with employee information and internal policies.',
    approvals: ['Posting to Slack'],
    extraProhibited: ['Give legal, medical or pay advice', 'Post personal data about anyone'],
    escalationWhen: ['The question concerns pay, health, discipline, a complaint or a legal matter'],
    limitations: ['Reads every knowledge source until you limit it: choose “Selected sources” and pick the HR documents before activating it.'],
  },
  {
    key: 'research_analyst',
    name: 'Research Analyst',
    department: 'research',
    purpose: 'Collects sources, researches companies, compares competitors and writes structured summaries, with a source for every fact.',
    requiredIntegrations: ['knowledge', 'hubspot'],
    skills: ['research.source_collection', 'research.company_profile', 'research.competitive_analysis', 'research.structured_summary', 'research.web_sources'],
    toolKeys: ['knowledge.search', 'hubspot.contacts.search'],
    knowledge: 'all',
    responsibilities: [
      'Collect relevant sources from the knowledge base and the material provided',
      'Profile companies from HubSpot and the knowledge base',
      'Compare competitors on the criteria the request gives',
      'Summarize findings with evidence, confidence and gaps',
    ],
    instructions: [
      'You research questions for the team.',
      'Every fact needs a source. Write “unknown” rather than filling a gap, and keep facts separate from interpretation.',
    ].join('\n'),
    successCriteria: ['Every fact has a source', 'Gaps are listed', 'Summaries state their confidence'],
    risk: 'low',
    riskReason: 'Read-only: it changes nothing.',
    approvals: [],
    extraProhibited: ['Present an assumption as a fact'],
    limitations: ['Uses only the knowledge base, HubSpot and the material provided.'],
    limits: { maxTurnsPerTask: 12, maxRuntimeSeconds: 240 },
    model: { effort: 'high' },
  },
  {
    key: 'knowledge_assistant',
    name: 'Knowledge Assistant',
    department: 'research',
    purpose: 'Finds answers in your documents and business context, with citations and an honest “not enough evidence” when they aren’t there.',
    requiredIntegrations: ['knowledge'],
    skills: ['knowledge.search', 'research.structured_summary'],
    toolKeys: ['knowledge.search'],
    knowledge: 'all',
    responsibilities: ['Answer questions from the organization’s documents and business context', 'Say clearly when the documents don’t contain the answer'],
    instructions: [
      'You answer questions from the organization’s knowledge base.',
      'Cite sources like [S1] for every fact. If the evidence is weak or missing, say so plainly.',
    ].join('\n'),
    successCriteria: ['Every fact is cited', 'Missing information is reported, not invented'],
    risk: 'low',
    riskReason: 'Read-only: it changes nothing.',
    approvals: [],
    extraProhibited: [],
    limitations: ['Searches only documents uploaded to Knowledge; it can’t browse the web.'],
  },
  {
    key: 'voice_receptionist',
    name: 'Voice Receptionist',
    department: 'voice',
    purpose: 'Answers inbound calls, tells callers they are speaking with an AI, finds out what they need, collects their details, books appointments, transfers to a person and summarizes every call.',
    requiredIntegrations: ['telephony', 'knowledge'],
    skills: ['voice.call_handling', 'voice.information_collection', 'voice.appointments', 'voice.human_transfer', 'voice.call_summary', 'support.inquiry_classification', 'support.cited_answers'],
    toolKeys: ['knowledge.search'],
    knowledge: 'all',
    responsibilities: [
      'Answer inbound calls and disclose that the caller is speaking with an AI',
      'Classify why the caller is calling',
      'Collect and confirm the caller’s details',
      'Transfer to a person when asked or required',
      'Summarize every call',
    ],
    instructions: 'You answer the phone for the business.',
    successCriteria: ['Every caller is told they are speaking with an AI', 'Every call ends with a summary', 'Callers who ask for a person are transferred or offered a call back'],
    risk: 'high',
    riskReason: 'Speaks to the public in real time and handles recordings and personal data.',
    approvals: ['Call recording only where consent is collected', 'Transfers go only to numbers an admin configured'],
    extraProhibited: ['Pretend to be a person', 'Make outbound calls'],
    limitations: ['Telephony isn’t built: no phone numbers, calls, speech recognition or speech synthesis exist. See docs/voice-employees.md.'],
  },
  {
    key: 'custom',
    name: 'Custom employee',
    department: 'custom',
    purpose: 'Start from a blank configuration and choose every tool, skill and rule yourself. It runs on the same runtime as every other employee.',
    requiredIntegrations: [],
    skills: [],
    toolKeys: [],
    knowledge: 'none',
    responsibilities: ['Describe what this employee is responsible for'],
    instructions: 'Describe how this employee should work.',
    successCriteria: ['Describe what a good result looks like'],
    risk: 'low',
    riskReason: 'Depends on the tools you grant.',
    approvals: ['Every tool that changes data or sends something starts with approval required'],
    extraProhibited: [],
    limitations: ['Can use only the tools that exist today: HubSpot, Slack and the knowledge base.'],
  },
]

export function getTemplate(key: string): EmployeeTemplate | undefined {
  return EMPLOYEE_TEMPLATES.find((template) => template.key === key)
}

function templateSkills(template: EmployeeTemplate): SkillDefinition[] {
  return template.skills.map(getSkill).filter((skill): skill is SkillDefinition => skill !== undefined)
}

export function templateAvailability(template: EmployeeTemplate): TemplateAvailability {
  if (!template.requiredIntegrations.every(isBuilt)) return 'planned'
  return templateSkills(template).every(isSkillAvailable) ? 'configurable' : 'partial'
}

/** The integrations a template needs, with what is built and how it was tested. */
export function templateIntegrations(template: EmployeeTemplate): { key: CapabilityKey; name: string; built: boolean; evidence: string }[] {
  return template.requiredIntegrations.map((key) => ({ key, name: EMPLOYEE_CAPABILITIES[key].name, built: isBuilt(key), evidence: EMPLOYEE_CAPABILITIES[key].evidence }))
}

/** What a template can honestly advertise: its tools' titles. */
export function templateCapabilities(template: EmployeeTemplate, catalog: readonly EmployeeToolInfo[]): string[] {
  return template.toolKeys
    .map((key) => catalog.find((tool) => tool.key === key))
    .filter((tool): tool is EmployeeToolInfo => Boolean(tool))
    .map(allowedActionFor)
}

/** Everything the template can't do: skills waiting for an integration, then its own limitations. */
export function templateLimitations(template: EmployeeTemplate): string[] {
  const waiting = templateSkills(template)
    .filter((skill) => !isSkillAvailable(skill))
    .map((skill) => {
      const missing = missingCapabilities(skill)
      return `${skill.name}: needs ${missing.join(' and ')}, which ${missing.length === 1 ? 'isn’t' : 'aren’t'} built yet.`
    })
  return [...waiting, ...template.limitations]
}

export class TemplateUnavailableError extends Error {
  constructor(template: EmployeeTemplate) {
    super(`The “${template.name}” template needs integrations that aren’t built yet.`)
    this.name = 'TemplateUnavailableError'
  }
}

/**
 * The draft a template starts from. Only available skills are included.
 * Connections are filled in when exactly one connected account exists for a
 * tool's provider; otherwise the builder asks the user to choose. Throws for
 * a template that isn't available.
 */
export function buildTemplateDraft(
  template: EmployeeTemplate,
  catalog: readonly EmployeeToolInfo[],
  connectionFor: (provider: string) => string | null = () => null,
): EmployeeDraft {
  if (templateAvailability(template) === 'planned') throw new TemplateUnavailableError(template)
  const tools = template.toolKeys
    .map((key) => catalog.find((tool) => tool.key === key))
    .filter((tool): tool is EmployeeToolInfo => Boolean(tool))
  return {
    instructions: template.instructions,
    config: {
      profile: { name: template.name, department: template.department, description: template.purpose, templateKey: template.key },
      responsibilities: [...template.responsibilities],
      skills: templateSkills(template)
        .filter(isSkillAvailable)
        .map((skill) => skill.key),
      tools: tools.map((tool) => defaultGrant(tool, tool.needsConnection ? connectionFor(tool.provider) : null)),
      knowledge: { access: template.knowledge, sourceIds: [], maxPassages: 6 },
      model: { ...DEFAULT_MODEL, ...template.model },
      successCriteria: [...template.successCriteria],
      allowedActions: tools.map(allowedActionFor),
      prohibitedActions: [...DEFAULT_PROHIBITED_ACTIONS, ...template.extraProhibited],
      escalation: { ...DEFAULT_ESCALATION, when: [...DEFAULT_ESCALATION.when, ...(template.escalationWhen ?? [])] },
      limits: { ...DEFAULT_LIMITS, ...template.limits },
      budget: { ...DEFAULT_BUDGET },
    },
  }
}

/** What the template gallery shows for one template: its declarations, resolved against what exists. */
export interface TemplateCard {
  key: string
  name: string
  department: Department
  purpose: string
  availability: TemplateAvailability
  integrations: { name: string; built: boolean; evidence: string; connected: boolean | null }[]
  skills: { name: string; available: boolean }[]
  permissions: { title: string; approval: boolean }[]
  capabilities: string[]
  risk: TemplateRisk
  riskReason: string
  approvals: string[]
  successCriteria: string[]
  limitations: string[]
}

/** Every template as a gallery card; `connected` says whether this workspace has each integration that needs a connection. */
export function templateCards(catalog: readonly EmployeeToolInfo[], connections: readonly ConnectionOption[]): TemplateCard[] {
  const connectable = new Set<string>(catalog.filter((tool) => tool.needsConnection).map((tool) => tool.provider))
  const connected = new Set(connections.filter((connection) => connection.status === 'connected').map((connection) => connection.provider))
  return EMPLOYEE_TEMPLATES.map((template) => ({
    key: template.key,
    name: template.name,
    department: template.department,
    purpose: template.purpose,
    availability: templateAvailability(template),
    integrations: templateIntegrations(template).map((integration) => ({
      name: integration.name,
      built: integration.built,
      evidence: integration.evidence,
      connected: connectable.has(integration.key) ? connected.has(integration.key) : null,
    })),
    skills: templateSkills(template).map((skill) => ({ name: skill.name, available: isSkillAvailable(skill) })),
    permissions: template.toolKeys.flatMap((key) => {
      const tool = catalog.find((candidate) => candidate.key === key)
      return tool ? [{ title: tool.title, approval: tool.risk !== 'read' }] : []
    }),
    capabilities: templateCapabilities(template, catalog),
    risk: template.risk,
    riskReason: template.riskReason,
    approvals: template.approvals,
    successCriteria: template.successCriteria,
    limitations: templateLimitations(template),
  }))
}


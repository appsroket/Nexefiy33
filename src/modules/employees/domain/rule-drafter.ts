// Turns a plain-language description into a draft without a model, by
// keyword rules. Used when no AI model is configured, and labelled as such:
// it is a starting point for review, not an interpretation.
//
// It never adds a tool that doesn't exist. Requests that no built tool can
// serve (web research, email, calendars, phone calls…) are listed as
// "unsupported" so the reviewer sees them instead of a silent omission.

import { allowedActionFor, defaultGrant, DEFAULT_BUDGET, DEFAULT_ESCALATION, DEFAULT_LIMITS, DEFAULT_MODEL, DEFAULT_PROHIBITED_ACTIONS } from './defaults'
import type { Department, EmployeeDraft, EmployeeToolInfo } from './types'

export interface DraftResult {
  draft: EmployeeDraft
  /** How the draft was produced, for the reviewer. */
  notes: string[]
  /** Parts of the description no existing tool can do. */
  unsupported: string[]
}

const DEPARTMENT_KEYWORDS: [Department, RegExp][] = [
  ['sales', /\b(sales|lead|leads|prospect|deal|pipeline|crm)\b/i],
  ['support', /\b(support|customer service|ticket|help ?desk|faq|complaint)\b/i],
  ['marketing', /\b(marketing|campaign|newsletter|social media|content)\b/i],
  ['operations', /\b(operations|ops|team update|standup|logistics|coordinat)/i],
  ['research', /\b(research|knowledge|documentation|policy questions)\b/i],
  ['analytics', /\b(analytics|report|metrics|kpi|dashboard)\b/i],
  ['executive_assistant', /\b(executive|assistant to|inbox|calendar)\b/i],
  ['finance_admin', /\b(finance|invoice|billing|expense|accounting)\b/i],
  ['hr_admin', /\b(hr|human resources|recruit|onboarding new hires|payroll)\b/i],
]

interface ToolRule {
  toolKey: string
  pattern: RegExp
}

const TOOL_RULES: ToolRule[] = [
  { toolKey: 'hubspot.contacts.search', pattern: /\b(crm|hubspot|contact|contacts|duplicate|duplicates|lead|leads|customer record)\b/i },
  // A write verb within a few words of what it writes ("creates the contact", "update leads in HubSpot").
  { toolKey: 'hubspot.contacts.upsert', pattern: /\b(creat|updat|add|log|record|enter)\w*(?:\s+(?!notes?\b)\w+){0,3}\s+(contacts?|leads?|crm|hubspot)\b/i },
  { toolKey: 'hubspot.notes.create', pattern: /\bnotes?\b/i },
  { toolKey: 'slack.messages.post', pattern: /\b(slack|channel|post|notify|announce|team update)\b/i },
  { toolKey: 'slack.channels.list', pattern: /\b(slack|channel|channels)\b/i },
  { toolKey: 'knowledge.search', pattern: /\b(knowledge|docs?|documents?|faq|policy|policies|answer|answers|questions?|research|product information|handbook)\b/i },
]

interface UnsupportedRule {
  pattern: RegExp
  message: string
}

const UNSUPPORTED_RULES: UnsupportedRule[] = [
  {
    pattern: /\b(research\w*|enrich\w*|look(s|ing)? up|find(s|ing)? out about)\s+(?:\w+\s+){0,2}(leads?|compan(y|ies)|prospects?|people|the web|online)\b|\b(web|internet|google|linkedin|website)\b/i,
    message: 'Researching on the web: Nexefiy has no web research tool yet. The employee can only look things up in HubSpot and your knowledge base.',
  },
  {
    pattern: /\b(email|e-mail|gmail|outlook|inbox)\b|\bsend(ing)?\b(?!.*\bslack\b)/i,
    message: 'Sending email: no email integration exists yet. The employee can prepare messages in its reply, or post them to Slack after approval.',
  },
  { pattern: /\b(calendar|meeting|meetings|schedule|scheduling|book a call)\b/i, message: 'Calendars and scheduling: no calendar integration exists yet.' },
  { pattern: /\b(phone|call|calls|sms|text message|whatsapp|voice)\b/i, message: 'Phone calls and text messages: no voice or SMS integration exists yet.' },
  { pattern: /\b(invoice|invoices|payment|payments|stripe|quickbooks|xero)\b/i, message: 'Invoices and payments: no accounting or payment integration exists yet.' },
  { pattern: /\b(spreadsheet|sheets|excel|google drive|notion|jira|asana|trello)\b/i, message: 'That app isn’t connected to Nexefiy yet; only HubSpot, Slack and the knowledge base are available.' },
]

const APPROVAL_PATTERN = /\b(approv(al|e|ed)|sign[- ]off|review before|check with me|ask (me|first))\b/i

function titleCase(text: string): string {
  return text.replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\.+$/, '')
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : ''
}

/** "Create a sales operations employee that researches leads, …" → role "sales operations", duties […] */
export function parseDescription(description: string): { role: string | null; duties: string[] } {
  const text = description.replace(/\s+/g, ' ').trim()
  const roleMatch = /\b(?:an?|the)\s+([a-z][a-z\s-]{2,60}?)\s+(?:employee|assistant|agent|coordinator|specialist|helper|bot)\b/i.exec(text)
  const role = roleMatch?.[1]?.trim() ?? null
  const body = /\b(?:that|who|which|to)\s+(.+)$/i.exec(roleMatch ? text.slice(roleMatch.index + roleMatch[0].length) : text)?.[1] ?? text
  const duties = body
    .split(/,|;|\.\s|\band then\b/i)
    .map((part) => part.replace(/^\s*(and|then|also)\s+/i, ''))
    .map(sentence)
    .filter((part) => part.length >= 3)
    .slice(0, 10)
  return { role, duties }
}

export function detectDepartment(description: string): Department {
  for (const [department, pattern] of DEPARTMENT_KEYWORDS) if (pattern.test(description)) return department
  return 'custom'
}

export function draftFromDescription(
  description: string,
  catalog: readonly EmployeeToolInfo[],
  connectionFor: (provider: string) => string | null = () => null,
): DraftResult {
  const text = description.replace(/\s+/g, ' ').trim()
  const { role, duties } = parseDescription(text)
  const department = detectDepartment(text)
  const available = new Map(catalog.map((tool) => [tool.key, tool]))

  // Tools are matched against the duties, not the framing ("Create an employee that…").
  const duty = duties.length ? duties.join('. ') : text
  const toolKeys = TOOL_RULES.filter((rule) => rule.pattern.test(duty) && available.has(rule.toolKey)).map((rule) => rule.toolKey)
  // Adding notes or contacts implies looking them up first.
  if ((toolKeys.includes('hubspot.contacts.upsert') || toolKeys.includes('hubspot.notes.create')) && !toolKeys.includes('hubspot.contacts.search')) {
    toolKeys.unshift('hubspot.contacts.search')
  }
  const tools = toolKeys.map((key) => available.get(key)!).filter(Boolean)
  const unsupported = [...new Set(UNSUPPORTED_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.message))]
  const wantsApproval = APPROVAL_PATTERN.test(text)
  const usesKnowledge = toolKeys.includes('knowledge.search')

  const name = role ? `${titleCase(role)} Assistant` : 'New Employee'
  const responsibilities = duties.length ? duties : ['Describe what this employee is responsible for']
  const writes = tools.filter((tool) => tool.risk !== 'read')

  const successCriteria = [
    ...(/\bduplicate/i.test(text) ? ['No duplicate contacts are created'] : []),
    ...(wantsApproval || writes.length ? ['Nothing is changed or sent outside Nexefiy without approval'] : []),
    ...(usesKnowledge ? ['Facts come from the knowledge base or tools, with sources'] : []),
    'Requests it can’t complete are escalated with a clear reason',
  ]

  const instructions = [
    `You are ${role ? `the ${role} assistant` : 'an AI employee'} for this organization.`,
    `Your responsibilities:\n${responsibilities.map((duty) => `- ${duty}`).join('\n')}`,
    wantsApproval ? 'Ask for approval before sending anything or changing any record. The approval step is enforced; wait for it rather than working around it.' : null,
    unsupported.length ? `You can’t do the following yet, so say so if asked: ${unsupported.map((item) => item.split(':')[0]!.toLowerCase()).join(', ')}.` : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    draft: {
      instructions,
      config: {
        profile: { name: name.slice(0, 120), department, description: text.slice(0, 2000) },
        responsibilities: responsibilities.map((duty) => duty.slice(0, 300)),
        skills: [
          ...(tools.some((tool) => tool.provider === 'hubspot') ? ['crm.records'] : []),
          ...(tools.some((tool) => tool.provider === 'slack') ? ['chat.messaging'] : []),
          ...(usesKnowledge ? ['knowledge.search'] : []),
        ],
        tools: tools.map((tool) => defaultGrant(tool, tool.needsConnection ? connectionFor(tool.provider) : null)),
        knowledge: { access: usesKnowledge ? 'all' : 'none', sourceIds: [], maxPassages: 6 },
        model: { ...DEFAULT_MODEL },
        successCriteria: successCriteria.slice(0, 10),
        allowedActions: tools.map(allowedActionFor),
        prohibitedActions: [
          ...DEFAULT_PROHIBITED_ACTIONS,
          ...(unsupported.length ? ['Claim to have done something its tools can’t do (for example sending an email)'] : []),
        ],
        escalation: { ...DEFAULT_ESCALATION, when: [...DEFAULT_ESCALATION.when] },
        limits: { ...DEFAULT_LIMITS },
        budget: { ...DEFAULT_BUDGET },
      },
    },
    notes: [
      'Drafted with keyword rules because no AI model is configured on this deployment. Review every field.',
      tools.length ? `Matched tools: ${tools.map((tool) => tool.title).join(', ')}.` : 'No existing tool matched the description.',
      ...(writes.length ? ['Actions that change records or send messages require approval.'] : []),
    ],
    unsupported,
  }
}

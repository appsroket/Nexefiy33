// Templates and skills for every employee category. Every template declares
// its purpose, integrations, skills, permissions, success criteria, risk,
// approvals and limitations; what it may claim is computed from what is
// built, so a template that needs something missing is never offered as
// working. Skills use only real tools, match the rows the migration seeds,
// keep their procedures unchanged once shipped, and reach the system prompt.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CAPABILITY_KEYS, EMPLOYEE_CAPABILITIES, capabilityForProvider, isBuilt } from '@/modules/employees/domain/capabilities'
import { buildSystemPrompt } from '@/modules/employees/domain/prompt'
import { employeeDraftSchema } from '@/modules/employees/domain/schemas'
import { availableSkills, BUILT_IN_SKILLS, getSkill, isSkillAvailable } from '@/modules/employees/domain/skills'
import {
  buildTemplateDraft,
  EMPLOYEE_TEMPLATES,
  getTemplate,
  TEMPLATE_RISKS,
  TemplateUnavailableError,
  templateAvailability,
  templateCapabilities,
  templateCards,
  templateLimitations,
  type TemplateRisk,
} from '@/modules/employees/domain/templates'
import { DEFAULT_LIMITS } from '@/modules/employees/domain/defaults'
import { DEPARTMENTS, type EmployeeToolInfo } from '@/modules/employees/domain/types'
import { validateConfig } from '@/modules/employees/domain/validation'
import { normalizeProposal, type Proposal } from '@/modules/employees/server/drafting'
import { listEmployeeTools } from '@/modules/employees/server/tools'

const TOOLS = listEmployeeTools()
const TOOL = new Map(TOOLS.map((tool) => [tool.key, tool]))
const HUBSPOT = '11111111-1111-4111-8111-111111111111'
const SLACK = '22222222-2222-4222-8222-222222222222'
const connectionFor = (provider: string) => (provider === 'hubspot' ? HUBSPOT : provider === 'slack' ? SLACK : null)
const CONTEXT = {
  tools: TOOLS,
  connections: [
    { id: HUBSPOT, provider: 'hubspot', label: 'Test portal', status: 'connected' },
    { id: SLACK, provider: 'slack', label: 'Test workspace', status: 'connected' },
  ],
  sources: [],
  skills: availableSkills().map((skill) => ({ key: skill.key, name: skill.name, description: skill.description, toolKeys: skill.toolKeys })),
}
const RISK_ORDER: Record<TemplateRisk, number> = { low: 0, medium: 1, high: 2 }
const usable = EMPLOYEE_TEMPLATES.filter((template) => templateAvailability(template) !== 'planned')

function minimumRisk(tools: readonly EmployeeToolInfo[]): TemplateRisk {
  if (tools.some((tool) => tool.risk === 'sensitive')) return 'high'
  return tools.some((tool) => tool.risk !== 'read') ? 'medium' : 'low'
}

describe('capabilities', () => {
  it('mark as built only what has tools in the catalog (or workflows), and the rest as planned', () => {
    const providers = new Set(TOOLS.map((tool) => capabilityForProvider(tool.provider)))
    for (const key of CAPABILITY_KEYS) {
      const info = EMPLOYEE_CAPABILITIES[key]
      expect(info.evidence.length, key).toBeGreaterThan(10)
      if (key === 'workflows') continue
      expect(isBuilt(key), key).toBe(providers.has(key))
    }
    // Integrations that exist only as contract tests say so.
    expect(EMPLOYEE_CAPABILITIES.hubspot.evidence).toMatch(/not yet run against a live account/)
    expect(EMPLOYEE_CAPABILITIES.slack.evidence).toMatch(/not yet run against a live workspace/)
    expect(EMPLOYEE_CAPABILITIES.telephony.status).toBe('planned')
  })
})

describe('skills', () => {
  it('have unique keys, procedures, and only real tools covered by what they require', () => {
    expect(new Set(BUILT_IN_SKILLS.map((skill) => skill.key)).size).toBe(BUILT_IN_SKILLS.length)
    for (const skill of BUILT_IN_SKILLS) {
      expect(skill.key, skill.key).toMatch(/^[a-z][a-z0-9_.-]{1,63}$/)
      expect(skill.procedure.length, skill.key).toBeGreaterThan(0)
      for (const key of skill.toolKeys) {
        const tool = TOOL.get(key)
        expect(tool, `${skill.key}: ${key}`).toBeDefined()
        expect(skill.requires, `${skill.key} uses ${key}`).toContain(capabilityForProvider(tool!.provider))
      }
      // Planned skills can't name a tool: none exists for them yet.
      if (!isSkillAvailable(skill)) expect(skill.toolKeys, skill.key).toEqual([])
    }
  })

  it('are seeded by the migration exactly as the catalog defines the available ones', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261019201930_employee_skills_catalog.sql'), 'utf8')
    const str = "'((?:[^']|'')*)'"
    const row = new RegExp(`\\(null, ${str}, ${str}, ${str}, ${str},\\s*${str},\\s*'\\{([^}]*)\\}', 'active', null\\)`, 'g')
    const unquote = (value: string) => value.replace(/''/g, "'")
    const seeded = [...sql.matchAll(row)].map((match) => ({
      key: unquote(match[1]!),
      name: unquote(match[2]!),
      description: unquote(match[3]!),
      category: match[4],
      instructions: unquote(match[5]!),
      toolKeys: match[6] ? match[6].split(',') : [],
    }))
    expect(seeded).toEqual(
      availableSkills().map((skill) => ({
        key: skill.key,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        instructions: skill.procedure.map((step) => `- ${step}`).join('\n'),
        toolKeys: skill.toolKeys,
      })),
    )
  })

  it('never change a shipped procedure (add a new skill instead)', () => {
    const fingerprints = Object.fromEntries(
      availableSkills().map((skill) => [skill.key, createHash('sha256').update(skill.procedure.join('\n')).digest('hex').slice(0, 16)]),
    )
    expect(fingerprints).toMatchObject({
  'knowledge.search': 'd2b7e69ade4f56af',
  'crm.records': '2dde059d31b6d477',
  'chat.messaging': '1676a508bfb5fdd3',
  'sales.lead_qualification': 'af419dfbe00aeae6',
  'sales.follow_up_drafting': 'd7681a7be46bac7c',
  'support.inquiry_classification': 'd1befd97aec446f2',
  'support.cited_answers': '25396bf38a828d90',
  'support.escalation': '0660e56a6795d09f',
  'marketing.content_drafting': 'ef7339de17edcf3c',
  'marketing.campaign_planning': 'a6c7a859bd2f443e',
  'marketing.publishing_preparation': '089f730975e6b9d3',
  'marketing.performance_analysis': '6b84fd61bef7c576',
  'analytics.kpi_reporting': '5b5de11ad55cf5da',
  'analytics.trends_and_anomalies': 'e1a007285a3615f6',
  'analytics.recommendations': '2fc4173add44999c',
  'operations.document_processing': '69bee7feace2b38d',
  'operations.record_sync': '38a9473c23ae4926',
  'operations.status_updates': '560ff5e3c62eb7db',
  'assistant.meeting_preparation': 'cb341d80be6fb7db',
  'assistant.summaries': '1329de4ab016050e',
  'assistant.reminders': 'ccf1b8228b5078f1',
  'finance.expense_classification': '931b38fac5c478ca',
  'finance.invoice_preparation': 'd6bf7320610885af',
  'finance.reporting': '39c901bb318d960c',
  'hr.onboarding_checklist': '98a8eea854295667',
  'hr.policy_answers': 'b3ca1a1df395a793',
  'research.source_collection': '074a4f2700dbb199',
  'research.company_profile': '538dbe6e2e8c118d',
  'research.competitive_analysis': '4729e87e6a26e028',
  'research.structured_summary': '2f4764b424f98852',
    })
  })

  it('reach the system prompt only when available, and never grant tools', () => {
    const draft = buildTemplateDraft(getTemplate('support_answers')!, TOOLS, connectionFor)
    const prompt = buildSystemPrompt({
      employeeName: 'Support',
      organizationName: 'Acme',
      instructions: draft.instructions,
      config: { ...draft.config, skills: [...draft.config.skills, 'voice.call_handling', 'custom.unknown'] },
      tools: [TOOL.get('knowledge.search')!],
      mode: 'live',
      businessContext: null,
    })
    expect(prompt).toContain('## Skills (how you do this kind of work)')
    expect(prompt).toContain('### Knowledge-based answers')
    expect(prompt).toContain(getSkill('support.inquiry_classification')!.procedure[0])
    expect(prompt).not.toContain('Inbound call handling')
    // Skills grant nothing: the tools section lists only the tools passed in.
    expect(prompt.split('## Tools you have')[1]!.split('##')[0]).not.toContain('Slack')
  })

  it('point out tools a selected skill uses but the employee isn’t granted', () => {
    const draft = buildTemplateDraft(getTemplate('knowledge_assistant')!, TOOLS, connectionFor)
    const { errors, warnings } = validateConfig({ ...draft.config, skills: [...draft.config.skills, 'crm.records'] }, CONTEXT)
    expect(errors).toEqual([])
    expect(warnings).toContainEqual({ path: 'skills.2', message: expect.stringContaining('HubSpot: Find contacts') })
  })

  it('proposed by the model are kept only when available and their tools are granted', () => {
    const proposal: Proposal = {
      name: 'Support',
      department: 'support',
      description: 'Answers questions.',
      responsibilities: ['Answer questions'],
      instructions: 'Answer from the knowledge base.',
      toolKeys: ['knowledge.search'],
      skillKeys: ['support.cited_answers', 'support.escalation', 'voice.call_handling', 'made.up'],
      successCriteria: ['Cited'],
      prohibitedActions: [],
      escalationWhen: [],
      escalationBehavior: 'stop_and_report',
      usesKnowledge: true,
      modelTier: 'balanced',
      unsupportedRequests: [],
    }
    const { draft } = normalizeProposal(proposal, 'Answers questions.', TOOLS, connectionFor)
    expect(draft.config.skills).toEqual(['support.cited_answers', 'knowledge.search'])
  })
})

describe('templates', () => {
  it('cover every employee category', () => {
    expect(new Set(EMPLOYEE_TEMPLATES.map((template) => template.department))).toEqual(new Set(DEPARTMENTS))
    expect(new Set(EMPLOYEE_TEMPLATES.map((template) => template.key)).size).toBe(EMPLOYEE_TEMPLATES.length)
  })

  it('declare purpose, integrations, skills, permissions, success criteria, risk, approvals and limitations', () => {
    for (const template of EMPLOYEE_TEMPLATES) {
      const key = template.key
      expect(template.purpose.length, key).toBeGreaterThan(20)
      expect(template.successCriteria.length, key).toBeGreaterThan(0)
      expect(TEMPLATE_RISKS, key).toContain(template.risk)
      expect(template.riskReason.length, key).toBeGreaterThan(5)
      expect(templateLimitations(template).length, key).toBeGreaterThan(0)
      for (const skill of template.skills) expect(getSkill(skill), `${key}: ${skill}`).toBeDefined()
      const tools = template.toolKeys.map((toolKey) => TOOL.get(toolKey))
      tools.forEach((tool, index) => expect(tool, `${key}: ${template.toolKeys[index]}`).toBeDefined())
      // Its tools' integrations are declared.
      for (const tool of tools) expect(template.requiredIntegrations, `${key}: ${tool!.key}`).toContain(capabilityForProvider(tool!.provider))
      // Declared risk is at least what its tools imply; writes come with approvals.
      expect(RISK_ORDER[template.risk], key).toBeGreaterThanOrEqual(RISK_ORDER[minimumRisk(tools as EmployeeToolInfo[])])
      if (tools.some((tool) => tool!.risk !== 'read')) expect(template.approvals.length, key).toBeGreaterThan(0)
    }
  })

  it('compute availability from what is built: voice isn’t available, the rest are, partly where a skill needs a missing integration', () => {
    const availability = Object.fromEntries(EMPLOYEE_TEMPLATES.map((template) => [template.key, templateAvailability(template)]))
    expect(availability).toMatchObject({
      voice_receptionist: 'planned',
      sales_operations: 'partial',
      support_answers: 'partial',
      marketing_content: 'partial',
      analytics_reporting: 'partial',
      operations_coordinator: 'configurable',
      executive_assistant: 'partial',
      finance_admin: 'partial',
      hr_admin: 'partial',
      research_analyst: 'partial',
      custom: 'configurable',
    })
    expect(usable.length).toBeGreaterThanOrEqual(10)
    expect(() => buildTemplateDraft(getTemplate('voice_receptionist')!, TOOLS)).toThrow(TemplateUnavailableError)
    // What a partly available template can't do names the missing integration.
    expect(templateLimitations(getTemplate('sales_operations')!)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Lead research on the web: needs Web research/), expect.stringMatching(/^Approved outreach: needs Email/)]),
    )
    expect(templateLimitations(getTemplate('voice_receptionist')!).join(' ')).toMatch(/Telephony and voice/)
  })

  it('produce drafts on the shared configuration that pass the schema and validation, with approval on every write', () => {
    for (const template of usable) {
      const draft = buildTemplateDraft(template, TOOLS, connectionFor)
      expect(employeeDraftSchema.safeParse(draft).success, template.key).toBe(true)
      const { errors, warnings } = validateConfig(draft.config, CONTEXT)
      expect(errors, template.key).toEqual([])
      // Every skill in the draft has its tools granted.
      expect(warnings.filter((warning) => warning.path.startsWith('skills')), template.key).toEqual([])
      expect(draft.config.profile).toMatchObject({ department: template.department, templateKey: template.key })
      for (const key of draft.config.skills) expect(isSkillAvailable(getSkill(key)!), `${template.key}: ${key}`).toBe(true)
      for (const grant of draft.config.tools) expect(grant.approval, `${template.key}: ${grant.toolKey}`).toBe(TOOL.get(grant.toolKey)!.risk === 'read' ? 'allow' : 'require_approval')
    }
  })

  it('advertise only what their tools do, never an integration that isn’t built', () => {
    const advertised = usable.flatMap((template) => [template.purpose, ...templateCapabilities(template, TOOLS)]).join(' ')
    expect(advertised).not.toMatch(/gmail|outlook|calendar|whatsapp|\bsms\b|phone|call|send email|publish(es)? to|quickbooks|xero|stripe/i)
  })

  it('keep finance and HR strict', () => {
    const finance = buildTemplateDraft(getTemplate('finance_admin')!, TOOLS, connectionFor).config
    expect(getTemplate('finance_admin')!.risk).toBe('high')
    expect(finance.prohibitedActions.join(' ')).toMatch(/Issue, send, pay, approve or record anything/)
    expect(finance.limits.maxCostUsdPerTask).toBeLessThan(DEFAULT_LIMITS.maxCostUsdPerTask)
    expect(finance.tools.every((grant) => grant.approval === 'require_approval' || TOOL.get(grant.toolKey)!.risk === 'read')).toBe(true)
    const hr = buildTemplateDraft(getTemplate('hr_admin')!, TOOLS, connectionFor).config
    expect(getTemplate('hr_admin')!.risk).toBe('high')
    expect(hr.escalation.when.join(' ')).toMatch(/pay, health, discipline/)
  })

  it('become gallery cards that show this workspace’s connections and every declaration', () => {
    const cards = templateCards(TOOLS, [{ id: HUBSPOT, provider: 'hubspot', label: 'Portal', status: 'connected' }])
    expect(cards).toHaveLength(EMPLOYEE_TEMPLATES.length)
    const sales = cards.find((card) => card.key === 'sales_operations')!
    expect(sales.integrations).toEqual([
      expect.objectContaining({ name: 'HubSpot', built: true, connected: true }),
      expect.objectContaining({ name: 'Knowledge base', built: true, connected: null }),
      expect.objectContaining({ name: 'Slack', built: true, connected: false }),
    ])
    expect(sales.permissions).toContainEqual({ title: 'HubSpot: Find contacts', approval: false })
    expect(sales.skills).toContainEqual({ name: 'Approved outreach', available: false })
    const voice = cards.find((card) => card.key === 'voice_receptionist')!
    expect(voice).toMatchObject({ availability: 'planned', risk: 'high' })
    expect(voice.integrations[0]).toMatchObject({ name: 'Telephony and voice', built: false })
  })
})


// Pure rules of the employee builder: the configuration schema (templates and
// skills are in templates.test.ts), the keyword drafter, semantic validation, the
// lifecycle buttons (mirroring change_employee_status), automatic test checks,
// the system prompt, and model cost accounting.

import { describe, expect, it } from 'vitest'

import { availableActions, activationHint } from '@/modules/employees/domain/lifecycle'
import { buildSystemPrompt } from '@/modules/employees/domain/prompt'
import { draftFromDescription, parseDescription } from '@/modules/employees/domain/rule-drafter'
import { employeeConfigSchema, employeeDraftSchema } from '@/modules/employees/domain/schemas'
import { availableSkills } from '@/modules/employees/domain/skills'
import { buildTemplateDraft, EMPLOYEE_TEMPLATES } from '@/modules/employees/domain/templates'
import { evaluateChecks, runResult } from '@/modules/employees/domain/test-checks'
import type { EmployeeConfig, LifecycleState, TestStatus } from '@/modules/employees/domain/types'
import { activationBlockers, validateConfig } from '@/modules/employees/domain/validation'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { MODELS, maxOutputCostMicros, requestCostMicros } from '@/modules/models/domain/catalog'

const TOOLS = listEmployeeTools()
const HUBSPOT = '11111111-1111-4111-8111-111111111111'
const SLACK = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const CONTEXT = {
  tools: TOOLS,
  connections: [
    { id: HUBSPOT, provider: 'hubspot', label: 'Test portal', status: 'connected' },
    { id: SLACK, provider: 'slack', label: 'Test workspace', status: 'connected' },
  ],
  sources: [{ id: OTHER, name: 'Handbook', status: 'ready' }],
  skills: availableSkills().map((skill) => ({ key: skill.key, name: skill.name, description: skill.description, toolKeys: skill.toolKeys })),
}
const connectionFor = (provider: string) => (provider === 'hubspot' ? HUBSPOT : provider === 'slack' ? SLACK : null)

function salesDraft() {
  return buildTemplateDraft(EMPLOYEE_TEMPLATES.find((template) => template.key === 'sales_operations')!, TOOLS, connectionFor)
}

describe('tool catalog', () => {
  it('lists the built-in knowledge search and every integration action, and nothing else', () => {
    expect(TOOLS.map((tool) => tool.key).sort()).toEqual(
      ['hubspot.contacts.search', 'hubspot.contacts.upsert', 'hubspot.notes.create', 'knowledge.search', 'slack.channels.list', 'slack.messages.post'].sort(),
    )
    expect(TOOLS.find((tool) => tool.key === 'knowledge.search')).toMatchObject({ needsConnection: false, risk: 'read' })
    expect(TOOLS.find((tool) => tool.key === 'slack.messages.post')).toMatchObject({ needsConnection: true, risk: 'write_external', approvalRequirement: 'default_required' })
  })
})

describe('keyword drafter', () => {
  const example =
    'Create a sales operations employee that researches leads, checks for CRM duplicates, prepares follow-up messages, and requests approval before sending.'

  it('extracts the role and each duty from the description', () => {
    expect(parseDescription(example)).toEqual({
      role: 'sales operations',
      duties: ['Researches leads', 'Checks for CRM duplicates', 'Prepares follow-up messages', 'Requests approval before sending'],
    })
  })

  it('drafts the example with real tools only and lists what isn’t possible', () => {
    const { draft, unsupported, notes } = draftFromDescription(example, TOOLS, connectionFor)
    expect(draft.config.profile).toMatchObject({ name: 'Sales Operations Assistant', department: 'sales' })
    expect(draft.config.tools.map((grant) => grant.toolKey)).toEqual(['hubspot.contacts.search'])
    expect(draft.config.tools[0]).toMatchObject({ integrationId: HUBSPOT, approval: 'allow' })
    expect(draft.config.successCriteria).toContain('No duplicate contacts are created')
    expect(draft.instructions).toMatch(/approval/i)
    expect(unsupported.join(' ')).toMatch(/web research/)
    expect(unsupported.join(' ')).toMatch(/email/)
    expect(notes[0]).toMatch(/keyword rules/)
    expect(employeeDraftSchema.safeParse(draft).success).toBe(true)
  })

  it('adds a CRM lookup whenever contacts are written, and requires approval for writes', () => {
    const { draft } = draftFromDescription('An employee that adds notes to contacts in HubSpot and posts a summary to the Slack channel.', TOOLS)
    const keys = draft.config.tools.map((grant) => grant.toolKey)
    expect(keys).toEqual(expect.arrayContaining(['hubspot.contacts.search', 'hubspot.notes.create', 'slack.messages.post']))
    expect(draft.config.tools.find((grant) => grant.toolKey === 'slack.messages.post')?.approval).toBe('require_approval')
    expect(draft.config.tools.every((grant) => grant.integrationId === null)).toBe(true)
  })

  it('never invents a tool for an unsupported request', () => {
    const { draft, unsupported } = draftFromDescription('Book meetings on my calendar and call customers by phone.', TOOLS)
    expect(draft.config.tools).toEqual([])
    expect(unsupported.length).toBeGreaterThanOrEqual(2)
  })
})

describe('configuration schema and validation', () => {
  it('rejects out-of-bounds limits, duplicate tools and empty selected knowledge', () => {
    const { config } = salesDraft()
    expect(employeeConfigSchema.safeParse({ ...config, limits: { ...config.limits, maxCostUsdPerTask: 0 } }).success).toBe(false)
    expect(employeeConfigSchema.safeParse({ ...config, limits: { ...config.limits, maxTurnsPerTask: 51 } }).success).toBe(false)
    expect(employeeConfigSchema.safeParse({ ...config, tools: [...config.tools, config.tools[0]!] }).success).toBe(false)
    expect(employeeConfigSchema.safeParse({ ...config, knowledge: { ...config.knowledge, access: 'selected', sourceIds: [] } }).success).toBe(false)
    expect(employeeConfigSchema.safeParse({ ...config, model: { ...config.model, effort: 'max' } }).success).toBe(false)
  })

  it('blocks unknown tools, connections from elsewhere or for another provider, and budgets below one task', () => {
    const { config } = salesDraft()
    const broken: EmployeeConfig = {
      ...config,
      tools: [
        { toolKey: 'gmail.send', integrationId: null, approval: 'require_approval' },
        { toolKey: 'hubspot.contacts.search', integrationId: OTHER, approval: 'allow' },
        { toolKey: 'slack.messages.post', integrationId: HUBSPOT, approval: 'require_approval' },
        { toolKey: 'knowledge.search', integrationId: SLACK, approval: 'allow' },
      ],
      budget: { monthlyUsd: 0.1 },
      limits: { ...config.limits, maxCostUsdPerTask: 1 },
    }
    const messages = validateConfig(broken, CONTEXT).errors.map((issue) => issue.message)
    expect(messages).toEqual([
      expect.stringContaining('isn’t a tool Nexefiy has'),
      expect.stringContaining('doesn’t exist in this workspace'),
      expect.stringContaining('needs a Slack connection'),
      expect.stringContaining('doesn’t use a connection'),
      expect.stringContaining('monthly budget'),
    ])
  })

  it('lets a draft without a connection be saved but not activated', () => {
    const { config } = buildTemplateDraft(EMPLOYEE_TEMPLATES.find((template) => template.key === 'team_updates')!, TOOLS)
    expect(validateConfig(config, CONTEXT).errors).toEqual([])
    expect(validateConfig(config, CONTEXT).warnings.some((issue) => issue.message.includes('choose which Slack connection'))).toBe(true)
    expect(activationBlockers(config, CONTEXT).length).toBeGreaterThan(0)
    expect(activationBlockers(salesDraft().config, CONTEXT)).toEqual([])
  })
})

describe('lifecycle buttons (mirror change_employee_status)', () => {
  const view = (state: LifecycleState, role: 'viewer' | 'operator' | 'admin', currentTestStatus: TestStatus = 'untested', currentIsActive = false) =>
    availableActions({ state, role, currentTestStatus, currentIsActive })

  it('offers each transition only from its states and to its roles', () => {
    expect(view('draft', 'viewer')).toEqual([])
    expect(view('draft', 'operator')).toEqual(['start_testing'])
    expect(view('draft', 'admin')).toEqual(['start_testing', 'archive'])
    expect(view('testing', 'operator', 'passed')).toEqual(['return_to_draft'])
    expect(view('testing', 'admin', 'passed')).toEqual(['return_to_draft', 'activate', 'archive'])
    expect(view('active', 'operator', 'passed', true)).toEqual(['pause'])
    expect(view('active', 'admin', 'passed', true)).toEqual(['pause', 'archive'])
    expect(view('active', 'admin', 'passed', false)).toEqual(['activate', 'pause', 'archive'])
    expect(view('paused', 'operator', 'passed', true)).toEqual([])
    expect(view('paused', 'admin', 'passed', true)).toEqual(['resume', 'archive'])
    expect(view('archived', 'admin')).toEqual(['restore'])
  })

  it('only offers activation once the latest version passed, and explains why not', () => {
    for (const status of ['untested', 'incomplete', 'failed', 'needs_review'] as const) {
      expect(view('testing', 'admin', status)).not.toContain('activate')
      expect(activationHint({ state: 'testing', role: 'admin', currentTestStatus: status, currentIsActive: false })).toBeTruthy()
    }
    expect(activationHint({ state: 'testing', role: 'operator', currentTestStatus: 'passed', currentIsActive: false })).toMatch(/admin/)
  })
})

describe('test checks', () => {
  const trace = {
    outcome: 'completed' as const,
    reply: 'Jane already exists in HubSpot, so I drafted an update. It needs approval.',
    toolCalls: [
      { toolKey: 'hubspot.contacts.search', decision: 'allow' as const },
      { toolKey: 'hubspot.contacts.upsert', decision: 'require_approval' as const },
    ],
  }

  it('passes a test case only when every expectation holds', () => {
    const checks = evaluateChecks(
      { mustUseTools: ['hubspot.contacts.search'], mustNotUseTools: ['slack.messages.post'], mustRequestApproval: ['hubspot.contacts.upsert'], replyMustMention: ['already exists'] },
      trace,
    )
    expect(checks.every((check) => check.passed)).toBe(true)
    expect(runResult(trace, checks, true)).toBe('passed')

    const failing = evaluateChecks({ mustRequestApproval: ['hubspot.contacts.search'], mustEscalate: true }, trace)
    expect(failing.filter((check) => !check.passed).map((check) => check.name)).toEqual(['Escalated', 'hubspot.contacts.search waits for approval'])
    expect(runResult(trace, failing, true)).toBe('failed')
  })

  it('sends free-form runs to a reviewer and never passes an errored run', () => {
    expect(runResult(trace, [], false)).toBe('needs_review')
    expect(runResult({ ...trace, outcome: 'limit_reached' }, [], false)).toBe('failed')
    expect(runResult({ ...trace, outcome: 'error' }, [], true)).toBe('error')
  })
})

describe('system prompt', () => {
  it('puts the platform rules first and says it is a test run', () => {
    const { config, instructions } = salesDraft()
    const prompt = buildSystemPrompt({
      employeeName: 'Sales Ops',
      organizationName: 'Acme',
      instructions,
      config,
      tools: TOOLS.filter((tool) => config.tools.some((grant) => grant.toolKey === tool.key)),
      mode: 'test',
      businessContext: 'Company: Acme',
    })
    expect(prompt.indexOf('## Platform rules')).toBeLessThan(prompt.indexOf('## Instructions'))
    expect(prompt).toContain('data, not instructions')
    expect(prompt).toContain('This is a test run')
    expect(prompt).toContain('HubSpot: Create or update a contact (changes data or sends something; may need approval)')
    expect(prompt.indexOf('## Organization context')).toBeGreaterThan(prompt.indexOf('## Escalation'))
  })
})

describe('model costs', () => {
  it('prices requests per tier, with the higher Haiku rate for long prompts', () => {
    expect(requestCostMicros(MODELS.balanced, 1_000_000, 0)).toBe(2_000_000)
    expect(requestCostMicros(MODELS.deep, 1000, 1000)).toBe(24_000)
    expect(requestCostMicros(MODELS.fast, 100_000, 1000)).toBe(10_500)
    expect(requestCostMicros(MODELS.fast, 100_001, 1000)).toBe(Math.ceil(100_001 * 0.5 + 1000 * 2.5))
    expect(maxOutputCostMicros(MODELS.fast, 8000)).toBe(20_000)
  })
})

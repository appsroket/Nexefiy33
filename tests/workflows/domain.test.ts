// Workflow rules that need no database: data references (restricted grammar,
// no code), conditions and transformations, schedules, validation of graphs
// and resources, how runs move through a graph (sequential, conditional,
// parallel, failure and rejection paths), normalizing untrusted JSON, the
// templates and the keyword-rules drafter.

import { describe, expect, it } from 'vitest'

import { planRun, retryDelayMs, type StepStates } from '@/modules/workflows/domain/execution'
import { autoLayout, blankWorkflow, getWorkflowTemplate, newNode, normalizeDefinition, removeNode, renameNode, WORKFLOW_TEMPLATES } from '@/modules/workflows/domain/factory'
import { applyTransform, evaluateCondition, TransformError } from '@/modules/workflows/domain/logic'
import { parseReference, resolveTemplate, resolveText, type ResolutionScope } from '@/modules/workflows/domain/references'
import { draftWorkflowFromDescription } from '@/modules/workflows/domain/rule-drafter'
import { checkSchedule, nextRun, parseCron } from '@/modules/workflows/domain/schedule'
import type { BuilderContext, WorkflowDefinition, WorkflowNode } from '@/modules/workflows/domain/types'
import { approvalBetween, handoffs, referencesAvailableTo, validateWorkflow } from '@/modules/workflows/domain/validation'

const EMPLOYEE = 'a2000000-0000-4000-8000-000000000001'
const OTHER_EMPLOYEE = 'a2000000-0000-4000-8000-000000000002'
const HUBSPOT = 'a4000000-0000-4000-8000-000000000001'

const context: BuilderContext = {
  employees: [
    { id: EMPLOYEE, name: 'Sales Ops', status: 'active', activeVersionId: 'v-1', activeVersion: 1, toolKeys: ['hubspot.contacts.search'] },
    { id: OTHER_EMPLOYEE, name: 'Writer', status: 'paused', activeVersionId: 'v-2', activeVersion: 2, toolKeys: [] },
  ],
  tools: [
    {
      key: 'hubspot.contacts.upsert',
      title: 'HubSpot: Create or update a contact',
      provider: 'hubspot',
      providerName: 'HubSpot',
      risk: 'write_external',
      approval: 'default_required',
      fields: [
        { name: 'email', required: true, description: '', type: 'string' },
        { name: 'firstName', required: false, description: '', type: 'string' },
      ],
      outputFields: ['id', 'result', 'email', 'url'],
    },
    {
      key: 'slack.messages.post',
      title: 'Slack: Post a message',
      provider: 'slack',
      providerName: 'Slack',
      risk: 'write_external',
      approval: 'none',
      fields: [
        { name: 'channel', required: true, description: '', type: 'string' },
        { name: 'text', required: true, description: '', type: 'string' },
      ],
      outputFields: ['channel', 'ts'],
    },
  ],
  connections: [{ id: HUBSPOT, provider: 'hubspot', label: 'example.hubspot.com', status: 'connected' }],
}

const trigger: WorkflowNode = { id: 'trigger', type: 'trigger', label: 'Start', config: { kind: 'manual', cron: '', timezone: '' } }
const end = (id: string, status: 'succeeded' | 'failed' = 'succeeded'): WorkflowNode => ({ id, type: 'end', label: id, config: { status, summary: '' } })
const employee = (id: string, employeeId = EMPLOYEE, instructions = 'Do it.'): WorkflowNode => ({
  id,
  type: 'employee_task',
  label: id,
  config: { employeeId, instructions, outputs: [{ key: 'qualified', description: 'yes or no' }], timeoutMinutes: 60, requireVerified: true, retry: { maxAttempts: 3, backoffSeconds: 30 } },
})
const condition = (id: string, left: string): WorkflowNode => ({ id, type: 'condition', label: id, config: { match: 'all', rules: [{ left, operator: 'equals', right: 'yes' }] } })
const flow = (nodes: WorkflowNode[], edges: WorkflowDefinition['edges'], inputs: WorkflowDefinition['inputs'] = []): WorkflowDefinition => ({ inputs, nodes, edges, settings: { maxRunMinutes: 60, maxCostUsd: 5 } })
const codes = (definition: WorkflowDefinition, mode: 'draft' | 'activation' = 'draft') => {
  const report = validateWorkflow(definition, { mode, context, now: new Date('2026-10-19T08:00:00Z') })
  return { errors: report.errors.map((issue) => issue.code), warnings: report.warnings.map((issue) => issue.code) }
}

describe('references', () => {
  const scope: ResolutionScope = {
    inputs: { email: 'dana@example.com', count: 7 },
    steps: { review: { output: { summary: 'Real lead', tags: ['a', 'b'], nested: { deep: 1 } } } },
    run: { id: 'run-1', startedAt: '2026-10-19T08:00:00Z' },
  }

  it('parses only the restricted grammar', () => {
    expect(parseReference('inputs.email')).toMatchObject({ kind: 'input', key: 'email' })
    expect(parseReference('steps.review.output.nested.deep')).toMatchObject({ kind: 'step', nodeId: 'review', path: ['nested', 'deep'] })
    expect(parseReference('run.id')).toMatchObject({ kind: 'run', field: 'id' })
    for (const bad of ['process.env.SECRET', 'inputs.email.toUpperCase()', 'steps.review.summary', "steps.review.output['x']", 'constructor', '1+1']) {
      expect(parseReference(bad)).toHaveProperty('message')
    }
  })

  it('keeps the type of a single reference and fills text otherwise, never reaching prototypes', () => {
    expect(resolveTemplate('{{inputs.count}}', scope).value).toBe(7)
    expect(resolveTemplate(' {{ steps.review.output.tags }} ', scope).value).toEqual(['a', 'b'])
    expect(resolveText('Lead {{inputs.email}} ({{steps.review.output.tags.1}}) — {{run.id}}', scope).value).toBe('Lead dana@example.com (b) — run-1')
    const missing = resolveText('Hi {{steps.review.output.nope}} {{steps.other.output.x}}', scope)
    expect(missing).toMatchObject({ value: 'Hi  ', missing: ['{{steps.review.output.nope}}', '{{steps.other.output.x}}'] })
    expect(resolveTemplate('{{steps.review.output.__proto__}}', scope).value).toBe('')
    expect(resolveText('{{process.env.X}}', scope)).toMatchObject({ value: '', invalid: ['{{process.env.X}}'] })
  })
})

describe('conditions and transformations', () => {
  const scope: ResolutionScope = { inputs: { count: '12', name: ' Dana ', flag: 'yes', tags: ['vip'] }, steps: {}, run: { id: 'r', startedAt: '' } }

  it('evaluates a fixed set of operators', () => {
    const rule = (left: string, operator: Parameters<typeof evaluateCondition>[0]['rules'][number]['operator'], right = '') => evaluateCondition({ match: 'all', rules: [{ left, operator, right }] }, scope)
    expect(rule('{{inputs.count}}', 'greater_than', '5')).toBe(true)
    expect(rule('{{inputs.count}}', 'less_than', '5')).toBe(false)
    expect(rule('{{inputs.name}}', 'equals', 'dana')).toBe(true)
    expect(rule('{{inputs.tags}}', 'contains', 'VIP')).toBe(true)
    expect(rule('{{inputs.missing}}', 'is_empty')).toBe(true)
    expect(rule('{{inputs.name}}', 'not_contains', 'x')).toBe(true)
    expect(evaluateCondition({ match: 'any', rules: [{ left: '{{inputs.count}}', operator: 'equals', right: '1' }, { left: '{{inputs.flag}}', operator: 'equals', right: 'yes' }] }, scope)).toBe(true)
  })

  it('formats values and refuses ones that can’t take their format', () => {
    expect(applyTransform({ fields: [{ key: 'n', value: '{{inputs.count}}', format: 'number' }, { key: 'name', value: '{{inputs.name}}', format: 'trim' }, { key: 'up', value: 'x{{inputs.flag}}', format: 'uppercase' }, { key: 'ok', value: '{{inputs.flag}}', format: 'boolean' }] }, scope)).toEqual({ n: 12, name: 'Dana', up: 'XYES', ok: true })
    expect(() => applyTransform({ fields: [{ key: 'n', value: '{{inputs.name}}', format: 'number' }] }, scope)).toThrow(TransformError)
  })
})

describe('schedules', () => {
  it('parses five-field cron and refuses runs more often than every 5 minutes', () => {
    expect(parseCron('0 9 * * 1-5')).toMatchObject({ minutes: [0], hours: [9] })
    expect(parseCron('*/5 * * * *')).toMatchObject({ minutes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55] })
    expect(parseCron('* * * * *')).toMatch(/every 5 minutes/)
    expect(parseCron('0 25 * * *')).toMatch(/out of range/)
    expect(parseCron('0 9 * *')).toMatch(/five fields/)
    expect(parseCron('0 9 * * MON')).toMatch(/isn’t valid/)
  })

  it('finds the next run in the schedule’s time zone, across daylight-saving changes', () => {
    const weekdays = parseCron('0 9 * * 1-5') as Exclude<ReturnType<typeof parseCron>, string>
    // Friday 2026-10-16 10:00 UTC → Monday 09:00 UTC.
    expect(nextRun(weekdays, 'UTC', new Date('2026-10-16T10:00:00Z'))!.toISOString()).toBe('2026-10-19T09:00:00.000Z')
    const daily = parseCron('0 9 * * *') as Exclude<ReturnType<typeof parseCron>, string>
    expect(nextRun(daily, 'Europe/Paris', new Date('2026-07-01T00:00:00Z'))!.toISOString()).toBe('2026-07-01T07:00:00.000Z')
    expect(nextRun(daily, 'Europe/Paris', new Date('2026-01-15T00:00:00Z'))!.toISOString()).toBe('2026-01-15T08:00:00.000Z')
    expect(checkSchedule('0 9 * * *', 'Mars/Olympus', new Date())).toMatchObject({ ok: false })
    expect(checkSchedule('0 0 31 2 *', 'UTC', new Date())).toMatchObject({ ok: false, message: 'This schedule never runs.' })
  })
})

describe('validation', () => {
  const sequential = () =>
    flow(
      [trigger, employee('review', EMPLOYEE, 'Check {{inputs.email}}.'), condition('check', '{{steps.review.output.qualified}}'), end('yes'), end('no')],
      [
        { id: 'e1', source: 'trigger', target: 'review' },
        { id: 'e2', source: 'review', target: 'check' },
        { id: 'e3', source: 'check', target: 'yes', branch: 'true' },
        { id: 'e4', source: 'check', target: 'no', branch: 'false' },
      ],
      [{ key: 'email', label: 'Email', type: 'email', required: true, description: '' }],
    )

  it('accepts a complete workflow and a blank one', () => {
    expect(codes(sequential())).toEqual({ errors: [], warnings: [] })
    expect(codes(blankWorkflow())).toEqual({ errors: [], warnings: [] })
  })

  it('rejects broken structure', () => {
    const base = sequential()
    expect(codes({ ...base, nodes: base.nodes.filter((node) => node.type !== 'trigger') }).errors).toContain('missing_trigger')
    expect(codes({ ...base, nodes: [...base.nodes, { ...trigger, id: 'trigger2' }] }).errors).toContain('multiple_triggers')
    expect(codes({ ...base, edges: [...base.edges, { id: 'e5', source: 'check', target: 'review', branch: 'true' }] }).errors).toContain('cycle')
    expect(codes({ ...base, edges: base.edges.filter((edge) => edge.id !== 'e4') }).errors).toEqual(expect.arrayContaining(['missing_path', 'unreachable']))
    expect(codes({ ...base, edges: [...base.edges, { id: 'e6', source: 'review', target: 'yes', branch: 'true' }] }).errors).toContain('invalid_branch')
    expect(codes({ ...base, edges: [...base.edges, { id: 'e7', source: 'yes', target: 'no' }] }).errors).toContain('invalid_branch')
    expect(codes({ ...base, edges: [...base.edges, { id: 'e8', source: 'trigger', target: 'trigger' }] }).errors).toEqual(expect.arrayContaining(['self_connection', 'into_trigger']))
  })

  it('checks every reference: it must exist and always run first, on its success path', () => {
    const base = sequential()
    const withInstructions = (instructions: string) => ({ ...base, nodes: base.nodes.map((node) => (node.id === 'review' ? employee('review', EMPLOYEE, instructions) : node)) })
    expect(codes(withInstructions('{{inputs.phone}}')).errors).toContain('unknown_input')
    expect(codes(withInstructions('{{steps.check.output.result}}')).errors).toContain('reference_not_upstream')
    expect(codes(withInstructions('{{steps.review.output.summary}}')).errors).toContain('self_reference')
    expect(codes(withInstructions('{{steps.trigger.output.x}}')).errors).toContain('no_output')
    expect(codes(withInstructions('{{nope}}')).errors).toContain('invalid_reference')
    expect(codes(withInstructions('{{inputs.email')).errors).toContain('stray_braces')
    expect(codes({ ...base, nodes: base.nodes.map((node) => (node.id === 'check' ? condition('check', '{{steps.review.output.score}}') : node)) }).errors).toContain('unknown_output')

    const failurePath = flow(
      [trigger, employee('work'), { id: 'oops', type: 'end', label: 'oops', config: { status: 'failed', summary: '{{steps.work.output.summary}}' } }, end('done')],
      [
        { id: 'e1', source: 'trigger', target: 'work' },
        { id: 'e2', source: 'work', target: 'done' },
        { id: 'e3', source: 'work', target: 'oops', branch: 'failure' },
      ],
    )
    expect(codes(failurePath).errors).toContain('reference_on_failure_path')
  })

  it('treats inactive employees and disconnected resources as warnings in a draft and errors at activation', () => {
    const base = sequential()
    const paused = { ...base, nodes: base.nodes.map((node) => (node.id === 'review' ? employee('review', OTHER_EMPLOYEE, 'Check {{inputs.email}}.') : node)) }
    expect(codes(paused).warnings).toContain('employee_not_active')
    expect(codes(paused, 'activation').errors).toContain('employee_not_active')
    const unknown = { ...base, nodes: base.nodes.map((node) => (node.id === 'review' ? employee('review', 'a2000000-0000-4000-8000-0000000000ff') : node)) }
    expect(codes(unknown).errors).toContain('unknown_employee')
  })

  it('checks tool actions: the action exists, its fields, the connection, and warns on unreviewed writes', () => {
    const action = (patch: Partial<Extract<WorkflowNode, { type: 'tool_action' }>['config']>): WorkflowDefinition =>
      flow(
        [trigger, { id: 'post', type: 'tool_action', label: 'Post', config: { toolKey: 'slack.messages.post', integrationId: HUBSPOT, input: [{ field: 'channel', value: 'C0123456789' }, { field: 'text', value: 'Hi' }], requireApproval: false, retry: { maxAttempts: 1, backoffSeconds: 0 }, ...patch } }, end('done')],
        [
          { id: 'e1', source: 'trigger', target: 'post' },
          { id: 'e2', source: 'post', target: 'done' },
        ],
      )
    expect(codes(action({})).errors).toContain('unknown_connection')
    expect(codes(action({ toolKey: 'gmail.send' })).errors).toContain('unknown_tool')
    expect(codes(action({ input: [{ field: 'channel', value: 'C0123456789' }, { field: 'bcc', value: 'x' }] })).errors).toEqual(expect.arrayContaining(['unknown_field', 'missing_required_field']))
    const slackContext = { ...context, connections: [...context.connections, { id: 'a4000000-0000-4000-8000-000000000002', provider: 'slack', label: 'Team', status: 'connected' }] }
    const ok = action({ integrationId: 'a4000000-0000-4000-8000-000000000002' })
    expect(validateWorkflow(ok, { mode: 'draft', context: slackContext }).warnings.map((issue) => issue.code)).toContain('write_without_approval')
    expect(validateWorkflow(action({ integrationId: 'a4000000-0000-4000-8000-000000000002', requireApproval: true }), { mode: 'draft', context: slackContext }).warnings).toEqual([])
  })

  it('a scheduled workflow can’t require inputs, and its schedule must be valid', () => {
    const scheduled = { ...sequential(), nodes: sequential().nodes.map((node) => (node.type === 'trigger' ? { ...trigger, config: { kind: 'schedule' as const, cron: '* * * * *', timezone: 'UTC' } } : node)) }
    expect(codes(scheduled).errors).toEqual(expect.arrayContaining(['invalid_schedule', 'schedule_with_inputs']))
  })

  it('finds hand-offs between employees and whether an approval stands between them', () => {
    const definition = flow(
      [trigger, employee('a'), { id: 'gate', type: 'approval', label: 'Gate', config: { message: 'ok?', approverRole: 'admin', expiresInHours: 24 } }, employee('b', OTHER_EMPLOYEE), end('done')],
      [
        { id: 'e1', source: 'trigger', target: 'a' },
        { id: 'e2', source: 'a', target: 'gate' },
        { id: 'e3', source: 'gate', target: 'b', branch: 'approved' },
        { id: 'e4', source: 'b', target: 'done' },
      ],
    )
    expect(handoffs(definition).map(({ from, to }) => `${from.id}→${to.id}`)).toEqual(['a→b'])
    expect(approvalBetween(definition, 'a', 'b')).toBe(true)
    const direct = { ...definition, edges: [...definition.edges, { id: 'e5', source: 'a', target: 'b' }] }
    expect(approvalBetween(direct, 'a', 'b')).toBe(false)
  })

  it('offers each step the data it may use', () => {
    const options = referencesAvailableTo(sequential(), 'check', context).map((option) => option.value)
    expect(options).toEqual(expect.arrayContaining(['{{inputs.email}}', '{{steps.review.output.summary}}', '{{steps.review.output.qualified}}']))
    expect(options).not.toContain('{{steps.check.output.result}}')
  })
})

describe('how runs move through the graph', () => {
  const definition = flow(
    [trigger, condition('check', 'x'), employee('a'), employee('b'), employee('c'), end('done'), end('no')],
    [
      { id: 'e1', source: 'trigger', target: 'check' },
      { id: 'e2', source: 'check', target: 'a', branch: 'true' },
      { id: 'e3', source: 'check', target: 'no', branch: 'false' },
      { id: 'e4', source: 'a', target: 'b' },
      { id: 'e5', source: 'a', target: 'c' },
      { id: 'e6', source: 'b', target: 'done' },
      { id: 'e7', source: 'c', target: 'done' },
    ],
  )
  const done = (branch: StepStates[string]['branch'] = null) => ({ status: 'succeeded' as const, branch })

  it('starts with the trigger, follows the taken branch and skips the other', () => {
    expect(planRun(definition, {})).toMatchObject({ ready: ['trigger'], outcome: null })
    expect(planRun(definition, { trigger: done() })).toMatchObject({ ready: ['check'] })
    expect(planRun(definition, { trigger: done(), check: done('true') })).toMatchObject({ ready: ['a'], skip: ['no'] })
  })

  it('runs parallel branches and joins them when both are done', () => {
    const base = { trigger: done(), check: done('true'), a: done(), no: { status: 'skipped' as const, branch: null } }
    expect(planRun(definition, base)).toMatchObject({ ready: ['b', 'c'] })
    expect(planRun(definition, { ...base, b: done(), c: { status: 'running', branch: null } })).toMatchObject({ ready: [], outcome: null })
    expect(planRun(definition, { ...base, b: done(), c: done() })).toMatchObject({ ready: ['done'] })
    expect(planRun(definition, { ...base, b: done(), c: done(), done: done() })).toMatchObject({ outcome: { status: 'succeeded', endNodes: ['done'] } })
  })

  it('skips everything only a path not taken leads to', () => {
    const states = { trigger: done(), check: done('false') }
    expect(planRun(definition, states)).toMatchObject({ ready: ['no'], skip: ['a'] })
    expect(planRun(definition, { ...states, no: done(), a: { status: 'skipped', branch: null } })).toMatchObject({ skip: ['b', 'c'] })
  })

  it('a failure without a failure path, or a rejection without a rejected path, ends the run', () => {
    expect(planRun(definition, { trigger: done(), check: done('true'), a: { status: 'failed', branch: null } })).toMatchObject({ outcome: { status: 'failed', reason: 'step_failed', nodeId: 'a' } })
    const gated = flow(
      [trigger, { id: 'gate', type: 'approval', label: 'Gate', config: { message: 'ok?', approverRole: 'admin', expiresInHours: 1 } }, employee('work'), end('done'), end('broken', 'failed')],
      [
        { id: 'e1', source: 'trigger', target: 'gate' },
        { id: 'e2', source: 'gate', target: 'work', branch: 'approved' },
        { id: 'e3', source: 'work', target: 'done' },
        { id: 'e4', source: 'work', target: 'broken', branch: 'failure' },
      ],
    )
    expect(planRun(gated, { trigger: done(), gate: done('rejected') })).toMatchObject({ outcome: { status: 'rejected', nodeId: 'gate' } })
    const failed = { trigger: done(), gate: done('approved'), work: { status: 'failed' as const, branch: 'failure' as const } }
    expect(planRun(gated, failed)).toMatchObject({ ready: ['broken'], skip: ['done'] })
    expect(planRun(gated, { ...failed, broken: done(), done: { status: 'skipped', branch: null } })).toMatchObject({ outcome: { status: 'failed', reason: 'end_failed', endNodes: ['broken'] } })
  })

  it('backs off between tool-action attempts', () => {
    expect([retryDelayMs(30, 1), retryDelayMs(30, 2), retryDelayMs(30, 3), retryDelayMs(3600, 5)]).toEqual([30_000, 60_000, 120_000, 3_600_000])
  })
})

describe('building workflows', () => {
  it('normalizes untrusted JSON, refusing unknown step types', () => {
    expect(normalizeDefinition({ nodes: [{ id: 'x', type: 'script', config: {} }] })).toMatchObject({ ok: false })
    expect(normalizeDefinition({ edges: [] })).toMatchObject({ ok: false })
    const result = normalizeDefinition({ nodes: [{ id: 'trigger', type: 'trigger' }, { id: 'wait', type: 'delay', config: { minutes: '15' } }], edges: [{ source: 'trigger', target: 'wait', branch: 'sideways' }] })
    expect(result).toMatchObject({
      ok: true,
      definition: { nodes: [{ config: { kind: 'manual' } }, { config: { minutes: 15 } }], edges: [{ id: 'e1', source: 'trigger', target: 'wait' }], settings: { maxRunMinutes: 1440 } },
    })
    expect((result as { definition: WorkflowDefinition }).definition.edges[0]).not.toHaveProperty('branch')
  })

  it('renames a step everywhere it is used, and removes a step with its connections', () => {
    const definition = flow(
      [trigger, employee('review'), condition('check', '{{steps.review.output.qualified}}'), end('yes'), end('no')],
      [
        { id: 'e1', source: 'trigger', target: 'review' },
        { id: 'e2', source: 'review', target: 'check' },
        { id: 'e3', source: 'check', target: 'yes', branch: 'true' },
        { id: 'e4', source: 'check', target: 'no', branch: 'false' },
      ],
    )
    const renamed = renameNode(definition, 'review', 'qualify')
    expect(renamed.edges.map((edge) => edge.source)).toContain('qualify')
    expect((renamed.nodes.find((node) => node.id === 'check') as Extract<WorkflowNode, { type: 'condition' }>).config.rules[0]!.left).toBe('{{steps.qualify.output.qualified}}')
    expect(removeNode(definition, 'check').edges.map((edge) => edge.id)).toEqual(['e1'])
    expect(newNode('employee_task', definition.nodes).id).toBe('task_2')
    const layout = autoLayout(definition)
    expect(layout.trigger!.y).toBeLessThan(layout.review!.y)
    expect(layout.yes!.y).toBe(layout.no!.y)
  })

  it('templates are valid once the workspace’s employee and connection are filled in', () => {
    const lead = getWorkflowTemplate('lead_intake')!.build({ employeeId: EMPLOYEE, connectionFor: (provider) => (provider === 'hubspot' ? HUBSPOT : null) })
    expect(codes(lead, 'activation')).toEqual({ errors: [], warnings: [] })
    for (const template of WORKFLOW_TEMPLATES) {
      const empty = template.build({ employeeId: null, connectionFor: () => null })
      expect(validateWorkflow(empty, { mode: 'draft' }).errors.map((issue) => issue.code).every((code) => ['missing_employee', 'missing_connection'].includes(code)), template.key).toBe(true)
    }
  })

  it('the rules drafter uses only what the workspace has, puts approval before changes, and says what it left out', () => {
    const draft = draftWorkflowFromDescription('When a lead comes in, check it, and only if it is qualified, add the contact to HubSpot after a manager approves. Then send an email to the sales team.', context)
    const types = draft.definition.nodes.map((node) => node.type)
    expect(types).toEqual(expect.arrayContaining(['trigger', 'employee_task', 'condition', 'approval', 'tool_action', 'end']))
    expect(draft.definition.edges.find((edge) => edge.branch === 'approved')?.target).toBe('save_contact')
    expect(draft.unsupported.join(' ')).toMatch(/email/i)
    expect(draft.notes[0]).toMatch(/keyword rules/)
    expect(codes(draft.definition).errors).toEqual([])
    const scheduled = draftWorkflowFromDescription('Every weekday morning, write a summary and post it to Slack.', context)
    expect(scheduled.definition.nodes[0]).toMatchObject({ config: { kind: 'schedule', cron: '0 9 * * 1-5' } })
    expect(scheduled.definition.nodes.find((node) => node.id === 'post')).toMatchObject({ type: 'tool_action', config: { toolKey: 'slack.messages.post', integrationId: '' } })
    expect(scheduled.notes).toContain('Fill in the Slack channel id in “Post to Slack”.')
    expect(draftWorkflowFromDescription('Every day post the summary to Slack.', { ...context, tools: [] }).unsupported).toContain('An action the description mentions isn’t available.')
  })
})

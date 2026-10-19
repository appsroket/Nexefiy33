// Building workflows: default settings for each step type, starter templates,
// an automatic layout, and normalizing untrusted JSON (the JSON view, an
// import, a model's proposal) into a well-formed definition with every
// field present. Normalizing never makes a workflow valid — validation still
// decides. Pure and Zod-free.

import {
  APPROVER_ROLES,
  BRANCHES,
  CONDITION_OPERATORS,
  INPUT_TYPES,
  NODE_TYPE_INFO,
  NODE_TYPES,
  TRANSFORM_FORMATS,
  TRIGGER_KINDS,
  WORKFLOW_BOUNDS,
  type Branch,
  type NodeType,
  type RetryPolicy,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowInput,
  type WorkflowLayout,
  type WorkflowNode,
  type WorkflowSettings,
} from './types'

export const DEFAULT_SETTINGS: WorkflowSettings = { maxRunMinutes: 1440, maxCostUsd: 5 }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffSeconds: 30 }

export function defaultConfig(type: NodeType): WorkflowNode['config'] {
  switch (type) {
    case 'trigger':
      return { kind: 'manual', cron: '', timezone: '' }
    case 'employee_task':
      return { employeeId: '', instructions: '', outputs: [], timeoutMinutes: 240, requireVerified: true, retry: { ...DEFAULT_RETRY } }
    case 'tool_action':
      return { toolKey: '', integrationId: '', input: [], requireApproval: false, retry: { maxAttempts: 1, backoffSeconds: 30 } }
    case 'condition':
      return { match: 'all', rules: [{ left: '', operator: 'equals', right: '' }] }
    case 'approval':
      return { message: '', approverRole: 'admin', expiresInHours: 72 }
    case 'transform':
      return { fields: [{ key: 'value', value: '', format: 'text' }] }
    case 'delay':
      return { minutes: 60 }
    case 'end':
      return { status: 'succeeded', summary: '' }
  }
}

export function newNode(type: NodeType, existing: readonly WorkflowNode[]): WorkflowNode {
  const base = type === 'employee_task' ? 'task' : type === 'tool_action' ? 'action' : type
  let n = existing.filter((node) => node.type === type).length + 1
  let id = `${base}_${n}`
  const ids = new Set(existing.map((node) => node.id))
  while (ids.has(id)) id = `${base}_${++n}`
  return { id, type, label: NODE_TYPE_INFO[type].label, config: defaultConfig(type) } as WorkflowNode
}

export function newEdgeId(edges: readonly WorkflowEdge[]): string {
  const ids = new Set(edges.map((edge) => edge.id))
  let n = edges.length + 1
  while (ids.has(`e${n}`)) n++
  return `e${n}`
}

export function blankWorkflow(): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { kind: 'manual', cron: '', timezone: '' } },
      { id: 'end', type: 'end', label: 'Done', config: { status: 'succeeded', summary: 'Finished.' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'end' }],
    settings: { ...DEFAULT_SETTINGS },
  }
}

// --- Templates -------------------------------------------------------------------

export interface WorkflowTemplate {
  key: string
  name: string
  summary: string
  /** Fills in what the workspace has (an employee, a connection) where exactly one fits. */
  build(pick: { employeeId: string | null; connectionFor: (provider: string) => string | null }): WorkflowDefinition
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    key: 'lead_intake',
    name: 'New lead to HubSpot, after approval',
    summary: 'An employee checks a new lead; if it looks real, an admin approves and the contact is added to HubSpot.',
    build: ({ employeeId, connectionFor }) => ({
      inputs: [
        { key: 'email', label: 'Email', type: 'email', required: true, description: 'The lead’s email address.' },
        { key: 'name', label: 'Name', type: 'text', required: false, description: '' },
        { key: 'notes', label: 'Notes', type: 'long_text', required: false, description: 'What we know about the lead.' },
      ],
      nodes: [
        { id: 'trigger', type: 'trigger', label: 'New lead', config: { kind: 'manual', cron: '', timezone: '' } },
        {
          id: 'review',
          type: 'employee_task',
          label: 'Review the lead',
          config: {
            employeeId: employeeId ?? '',
            instructions: 'Review this lead: {{inputs.email}} ({{inputs.name}}). Notes: {{inputs.notes}}\nCheck whether it already exists in HubSpot and whether it looks like a real business contact. Do not create or change anything.',
            outputs: [
              { key: 'qualified', description: '“yes” if this looks like a real business contact we should add, otherwise “no”.' },
              { key: 'first_name', description: 'The lead’s first name, if known.' },
            ],
            timeoutMinutes: 60,
            requireVerified: true,
            retry: { ...DEFAULT_RETRY },
          },
        },
        { id: 'qualified', type: 'condition', label: 'Qualified?', config: { match: 'all', rules: [{ left: '{{steps.review.output.qualified}}', operator: 'equals', right: 'yes' }] } },
        {
          id: 'approve',
          type: 'approval',
          label: 'Approve adding the contact',
          config: { message: 'Add {{inputs.email}} to HubSpot?\nReview: {{steps.review.output.summary}}', approverRole: 'admin', expiresInHours: 48 },
        },
        {
          id: 'add_contact',
          type: 'tool_action',
          label: 'Add to HubSpot',
          config: {
            toolKey: 'hubspot.contacts.upsert',
            integrationId: connectionFor('hubspot') ?? '',
            input: [
              { field: 'email', value: '{{inputs.email}}' },
              { field: 'firstName', value: '{{steps.review.output.first_name}}' },
            ],
            requireApproval: false,
            retry: { maxAttempts: 2, backoffSeconds: 60 },
          },
        },
        { id: 'added', type: 'end', label: 'Added', config: { status: 'succeeded', summary: 'Added {{inputs.email}} to HubSpot.' } },
        { id: 'not_added', type: 'end', label: 'Not added', config: { status: 'succeeded', summary: '{{inputs.email}} wasn’t added.' } },
        { id: 'failed', type: 'end', label: 'Couldn’t add', config: { status: 'failed', summary: 'Adding {{inputs.email}} to HubSpot failed.' } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'review' },
        { id: 'e2', source: 'review', target: 'qualified' },
        { id: 'e3', source: 'qualified', target: 'approve', branch: 'true' },
        { id: 'e4', source: 'qualified', target: 'not_added', branch: 'false' },
        { id: 'e5', source: 'approve', target: 'add_contact', branch: 'approved' },
        { id: 'e6', source: 'approve', target: 'not_added', branch: 'rejected' },
        { id: 'e7', source: 'add_contact', target: 'added' },
        { id: 'e8', source: 'add_contact', target: 'failed', branch: 'failure' },
      ],
      settings: { ...DEFAULT_SETTINGS },
    }),
  },
  {
    key: 'daily_summary',
    name: 'Daily summary posted to Slack',
    summary: 'Every weekday morning an employee writes a summary, and it is posted to a Slack channel.',
    build: ({ employeeId, connectionFor }) => ({
      inputs: [],
      nodes: [
        { id: 'trigger', type: 'trigger', label: 'Weekdays at 9:00', config: { kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'UTC' } },
        {
          id: 'summarize',
          type: 'employee_task',
          label: 'Write the summary',
          config: {
            employeeId: employeeId ?? '',
            instructions: 'Write a short summary of what the team should know today, using the business knowledge you have. Keep it under 120 words. Do not post it yourself.',
            outputs: [{ key: 'message', description: 'The summary text to post.' }],
            timeoutMinutes: 60,
            requireVerified: true,
            retry: { ...DEFAULT_RETRY },
          },
        },
        {
          id: 'post',
          type: 'tool_action',
          label: 'Post to Slack',
          config: {
            toolKey: 'slack.messages.post',
            integrationId: connectionFor('slack') ?? '',
            input: [
              { field: 'channel', value: '' },
              { field: 'text', value: '{{steps.summarize.output.message}}' },
            ],
            requireApproval: true,
            retry: { maxAttempts: 1, backoffSeconds: 30 },
          },
        },
        { id: 'done', type: 'end', label: 'Posted', config: { status: 'succeeded', summary: 'Posted the daily summary.' } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'summarize' },
        { id: 'e2', source: 'summarize', target: 'post' },
        { id: 'e3', source: 'post', target: 'done' },
      ],
      settings: { maxRunMinutes: 720, maxCostUsd: 2 },
    }),
  },
]

export function getWorkflowTemplate(key: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template) => template.key === key)
}

// --- Layout ------------------------------------------------------------------------

const COLUMN = 280
const ROW = 150

/** Places steps in layers from the trigger (longest path), spreading branches side by side. */
export function autoLayout(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>): WorkflowLayout {
  const depth = new Map<string, number>()
  const ids = new Set(definition.nodes.map((node) => node.id))
  const roots = definition.nodes.filter((node) => !definition.edges.some((edge) => edge.target === node.id && ids.has(edge.source)))
  for (const root of roots) depth.set(root.id, 0)
  // Longest path, bounded so a cycle can't loop forever.
  for (let pass = 0; pass < definition.nodes.length; pass++) {
    let changed = false
    for (const edge of definition.edges) {
      const from = depth.get(edge.source)
      if (from === undefined || !ids.has(edge.target)) continue
      if ((depth.get(edge.target) ?? -1) < from + 1) {
        depth.set(edge.target, from + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  const layers = new Map<number, string[]>()
  for (const node of definition.nodes) {
    const level = depth.get(node.id) ?? 0
    layers.set(level, [...(layers.get(level) ?? []), node.id])
  }
  const layout: WorkflowLayout = {}
  for (const [level, members] of layers) {
    members.forEach((id, position) => {
      layout[id] = { x: Math.round((position - (members.length - 1) / 2) * COLUMN), y: level * ROW }
    })
  }
  return layout
}

/** Keeps known positions and places new steps; drops positions of removed steps. */
export function reconcileLayout(definition: WorkflowDefinition, layout: WorkflowLayout): WorkflowLayout {
  const auto = autoLayout(definition)
  const result: WorkflowLayout = {}
  for (const node of definition.nodes) {
    const known = layout[node.id]
    result[node.id] = known && Number.isFinite(known.x) && Number.isFinite(known.y) ? { x: Math.round(known.x), y: Math.round(known.y) } : auto[node.id]!
  }
  return result
}

// --- Normalizing untrusted JSON ---------------------------------------------------

type Loose = Record<string, unknown>

const obj = (value: unknown): Loose => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {})
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown, max: number, fallback = ''): string => (typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' ? String(value) : fallback)
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : fallback)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback
}

function retryOf(value: unknown, fallback: RetryPolicy): RetryPolicy {
  const raw = obj(value)
  return { maxAttempts: Math.round(num(raw.maxAttempts, fallback.maxAttempts)), backoffSeconds: Math.round(num(raw.backoffSeconds, fallback.backoffSeconds)) }
}

function configOf(type: NodeType, value: unknown): WorkflowNode['config'] {
  const raw = obj(value)
  const defaults = defaultConfig(type)
  switch (type) {
    case 'trigger':
      return { kind: oneOf(raw.kind, TRIGGER_KINDS, 'manual'), cron: str(raw.cron, 100), timezone: str(raw.timezone, 64) }
    case 'employee_task': {
      const d = defaults as Extract<WorkflowNode, { type: 'employee_task' }>['config']
      return {
        employeeId: str(raw.employeeId, 64),
        ...(typeof raw.employeeVersionId === 'string' ? { employeeVersionId: raw.employeeVersionId.slice(0, 64) } : {}),
        instructions: str(raw.instructions, WORKFLOW_BOUNDS.instructions + 1),
        outputs: arr(raw.outputs).slice(0, WORKFLOW_BOUNDS.outputs + 1).map((item) => ({ key: str(obj(item).key, 40), description: str(obj(item).description, 300) })),
        timeoutMinutes: Math.round(num(raw.timeoutMinutes, d.timeoutMinutes)),
        requireVerified: bool(raw.requireVerified, true),
        retry: retryOf(raw.retry, d.retry),
      }
    }
    case 'tool_action': {
      const d = defaults as Extract<WorkflowNode, { type: 'tool_action' }>['config']
      return {
        toolKey: str(raw.toolKey, 100),
        integrationId: str(raw.integrationId, 64),
        input: arr(raw.input).slice(0, WORKFLOW_BOUNDS.mappings + 1).map((item) => ({ field: str(obj(item).field, 64), value: str(obj(item).value, WORKFLOW_BOUNDS.template + 1) })),
        requireApproval: bool(raw.requireApproval, false),
        retry: retryOf(raw.retry, d.retry),
      }
    }
    case 'condition':
      return {
        match: oneOf(raw.match, ['all', 'any'] as const, 'all'),
        rules: arr(raw.rules)
          .slice(0, WORKFLOW_BOUNDS.rules + 1)
          .map((item) => ({ left: str(obj(item).left, WORKFLOW_BOUNDS.template + 1), operator: oneOf(obj(item).operator, CONDITION_OPERATORS, 'equals'), right: str(obj(item).right, WORKFLOW_BOUNDS.template + 1) })),
      }
    case 'approval':
      return { message: str(raw.message, WORKFLOW_BOUNDS.template + 1), approverRole: oneOf(raw.approverRole, APPROVER_ROLES, 'admin'), expiresInHours: Math.round(num(raw.expiresInHours, 72)) }
    case 'transform':
      return {
        fields: arr(raw.fields)
          .slice(0, WORKFLOW_BOUNDS.fields + 1)
          .map((item) => ({ key: str(obj(item).key, 40), value: str(obj(item).value, WORKFLOW_BOUNDS.template + 1), format: oneOf(obj(item).format, TRANSFORM_FORMATS, 'text') })),
      }
    case 'delay':
      return { minutes: Math.round(num(raw.minutes, 60)) }
    case 'end':
      return { status: oneOf(raw.status, ['succeeded', 'failed'] as const, 'succeeded'), summary: str(raw.summary, WORKFLOW_BOUNDS.template + 1) }
  }
}

export type NormalizeResult = { ok: true; definition: WorkflowDefinition } | { ok: false; message: string }

/** Turns parsed JSON into a definition with every field present, or explains why it can't. */
export function normalizeDefinition(value: unknown): NormalizeResult {
  const raw = obj(value)
  if (!Array.isArray(raw.nodes)) return { ok: false, message: 'A workflow needs a “nodes” list.' }
  if (raw.nodes.length > WORKFLOW_BOUNDS.nodes * 2 || arr(raw.edges).length > WORKFLOW_BOUNDS.edges * 2) return { ok: false, message: 'This workflow is far too large.' }
  const nodes: WorkflowNode[] = []
  for (const item of raw.nodes) {
    const node = obj(item)
    const type = node.type
    if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) {
      return { ok: false, message: `“${str(type, 40) || '(none)'}” isn’t a step type. Use one of: ${NODE_TYPES.join(', ')}.` }
    }
    nodes.push({ id: str(node.id, 64), type: type as NodeType, label: str(node.label, WORKFLOW_BOUNDS.label), config: configOf(type as NodeType, node.config) } as WorkflowNode)
  }
  const edges: WorkflowEdge[] = arr(raw.edges).map((item, position) => {
    const edge = obj(item)
    const branch = typeof edge.branch === 'string' && (BRANCHES as readonly string[]).includes(edge.branch) ? (edge.branch as Branch) : undefined
    return { id: str(edge.id, 64) || `e${position + 1}`, source: str(edge.source, 64), target: str(edge.target, 64), ...(branch ? { branch } : {}) }
  })
  const inputs: WorkflowInput[] = arr(raw.inputs).map((item) => {
    const input = obj(item)
    return {
      key: str(input.key, 40),
      label: str(input.label, WORKFLOW_BOUNDS.label),
      type: oneOf(input.type, INPUT_TYPES, 'text'),
      required: bool(input.required, false),
      description: str(input.description, 300),
    }
  })
  const settings = obj(raw.settings)
  return {
    ok: true,
    definition: {
      inputs,
      nodes,
      edges,
      settings: {
        maxRunMinutes: Math.round(num(settings.maxRunMinutes, DEFAULT_SETTINGS.maxRunMinutes)),
        maxCostUsd: settings.maxCostUsd === null ? null : num(settings.maxCostUsd, DEFAULT_SETTINGS.maxCostUsd ?? 5),
      },
    },
  }
}

/** Removes a step and every connection to it. */
export function removeNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.filter((node) => node.id !== nodeId), edges: definition.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId) }
}

/** Renames a step id, updating connections and {{steps.<id>…}} references. */
export function renameNode(definition: WorkflowDefinition, from: string, to: string): WorkflowDefinition {
  const pattern = new RegExp(`(\\{\\{\\s*steps\\.)${from.replace(/[-]/g, '\\-')}(\\.)`, 'g')
  const rewrite = (text: string) => text.replace(pattern, `$1${to}$2`)
  const nodes = definition.nodes.map((node) => {
    const renamed = { ...node, id: node.id === from ? to : node.id }
    return { ...renamed, config: JSON.parse(rewrite(JSON.stringify(node.config))) } as WorkflowNode
  })
  return {
    ...definition,
    nodes,
    edges: definition.edges.map((edge) => ({ ...edge, source: edge.source === from ? to : edge.source, target: edge.target === from ? to : edge.target })),
  }
}

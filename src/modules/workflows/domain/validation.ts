// Validating a workflow. The same checks run in the editor (instant feedback),
// when a draft is saved, and again on the server before a version is
// activated, where the context (employees, tools, connections) is read from
// the database rather than trusted from the browser:
//
//   structure    one trigger, at least one end, edges between existing
//                steps with branches the step allows, every required branch
//                present, no cycles, nothing unreachable, limits;
//   steps        every step's settings complete and in range;
//   data         every {{reference}} is valid, points to an input that exists
//                or to an earlier step that always runs first (and not only
//                on its failure path), and to an output that step produces;
//   resources    employees exist and are active, tools exist, connections
//                belong to the workspace, match the tool and are connected,
//                mapped fields exist and required ones are mapped.
//
// Permissions and policies (the executor's decision for each action, and
// hand-offs between employees) are checked on the server only
// (server/validation.ts). Some resource problems are warnings in a draft and
// errors at activation. Pure and Zod-free.

import { dominators, findCycle, indexGraph, reachableAvoiding, reachableFrom, topologicalOrder, type GraphIndex } from './graph'
import { hasStrayBraces, isReferenceError, referencesIn } from './references'
import { checkSchedule } from './schedule'
import {
  KEY_PATTERN,
  NODE_ID_PATTERN,
  NODE_TYPE_INFO,
  NODE_TYPES,
  UNARY_OPERATORS,
  WORKFLOW_BOUNDS,
  type BuilderContext,
  type EmployeeTaskNode,
  type ToolActionNode,
  type WorkflowDefinition,
  type WorkflowNode,
} from './types'

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  nodeId?: string
  edgeId?: string
}

export interface ValidationReport {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

export type ValidationMode = 'draft' | 'activation'

export interface ValidationOptions {
  mode: ValidationMode
  /** Omitted: resource checks are skipped (e.g. before the context has loaded). */
  context?: BuilderContext
  now?: Date
}

/** Every templated string in a step, with a label for messages. */
export function templatesOf(node: WorkflowNode): { where: string; template: string }[] {
  switch (node.type) {
    case 'employee_task':
      return [{ where: 'instructions', template: node.config.instructions }]
    case 'tool_action':
      return node.config.input.map((mapping) => ({ where: `field “${mapping.field}”`, template: mapping.value }))
    case 'condition':
      return node.config.rules.flatMap((rule, index) => [
        { where: `rule ${index + 1}`, template: rule.left },
        { where: `rule ${index + 1}`, template: rule.right },
      ])
    case 'approval':
      return [{ where: 'message', template: node.config.message }]
    case 'transform':
      return node.config.fields.map((field) => ({ where: `field “${field.key}”`, template: field.value }))
    case 'end':
      return [{ where: 'summary', template: node.config.summary }]
    default:
      return []
  }
}

/** Output fields a step produces, or null when they can't be known (any path is accepted). */
export function outputKeysOf(node: WorkflowNode, context?: BuilderContext): string[] | null {
  switch (node.type) {
    case 'employee_task':
      return ['summary', 'status', ...node.config.outputs.map((output) => output.key)]
    case 'tool_action': {
      const tool = context?.tools.find((item) => item.key === node.config.toolKey)
      return tool && tool.outputFields.length ? tool.outputFields : null
    }
    case 'condition':
      return ['result']
    case 'approval':
      return ['decision', 'note']
    case 'transform':
      return node.config.fields.map((field) => field.key)
    default:
      return []
  }
}

/** Pairs of employee steps where work passes from one employee to another (a hand-off). */
export function handoffs(definition: WorkflowDefinition): { from: EmployeeTaskNode; to: EmployeeTaskNode }[] {
  const index = indexGraph(definition)
  const employees = definition.nodes.filter((node): node is EmployeeTaskNode => node.type === 'employee_task')
  const pairs: { from: EmployeeTaskNode; to: EmployeeTaskNode }[] = []
  for (const from of employees) {
    const reach = reachableFrom(index, from.id)
    for (const to of employees) {
      if (to.id !== from.id && reach.has(to.id) && to.config.employeeId && to.config.employeeId !== from.config.employeeId) pairs.push({ from, to })
    }
  }
  return pairs
}

/** Whether an approval step stands between two steps on every path. */
export function approvalBetween(definition: WorkflowDefinition, from: string, to: string, index: GraphIndex = indexGraph(definition)): boolean {
  const types = new Map(definition.nodes.map((node) => [node.id, node.type]))
  return !reachableAvoiding(index, from, to, (id) => types.get(id) === 'approval')
}

/** Whether an approval step comes before this step on every path from the trigger. */
export function approvedBeforehand(definition: WorkflowDefinition, nodeId: string): boolean {
  const trigger = definition.nodes.find((node) => node.type === 'trigger')
  return trigger ? approvalBetween(definition, trigger.id, nodeId) : false
}

const inRange = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max

export function validateWorkflow(definition: WorkflowDefinition, options: ValidationOptions): ValidationReport {
  const issues: ValidationIssue[] = []
  const { context, mode } = options
  const strict = mode === 'activation'
  const error = (code: string, message: string, at: { nodeId?: string; edgeId?: string } = {}) => issues.push({ severity: 'error', code, message, ...at })
  const warn = (code: string, message: string, at: { nodeId?: string; edgeId?: string } = {}) => issues.push({ severity: 'warning', code, message, ...at })
  /** A resource problem: a warning while drafting, an error at activation. */
  const resource = (code: string, message: string, at: { nodeId?: string } = {}) => (strict ? error : warn)(code, message, at)

  // --- Limits and identity ---------------------------------------------------
  if (definition.nodes.length > WORKFLOW_BOUNDS.nodes) error('too_many_steps', `A workflow can have up to ${WORKFLOW_BOUNDS.nodes} steps.`)
  if (definition.edges.length > WORKFLOW_BOUNDS.edges) error('too_many_connections', `A workflow can have up to ${WORKFLOW_BOUNDS.edges} connections.`)
  if (definition.inputs.length > WORKFLOW_BOUNDS.inputs) error('too_many_inputs', `A workflow can have up to ${WORKFLOW_BOUNDS.inputs} inputs.`)

  const byId = new Map<string, WorkflowNode>()
  for (const node of definition.nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) error('invalid_step_id', `“${node.id}” isn’t a valid step id (letters, numbers, - and _; starting with a letter).`, { nodeId: node.id })
    if (byId.has(node.id)) error('duplicate_step_id', `Two steps share the id “${node.id}”.`, { nodeId: node.id })
    if (!(NODE_TYPES as readonly string[]).includes(node.type)) error('unknown_step_type', `“${node.id}” has an unknown type.`, { nodeId: node.id })
    if (!node.label.trim()) warn('missing_label', `Step “${node.id}” has no name.`, { nodeId: node.id })
    byId.set(node.id, node)
  }

  const inputKeys = new Set<string>()
  for (const input of definition.inputs) {
    if (!KEY_PATTERN.test(input.key)) error('invalid_input_key', `Input key “${input.key}” should start with a lowercase letter and use only letters, numbers and _.`)
    else if (inputKeys.has(input.key)) error('duplicate_input', `Two inputs share the key “${input.key}”.`)
    if (!input.label.trim()) error('missing_input_label', `Input “${input.key}” needs a label.`)
    inputKeys.add(input.key)
  }

  if (!inRange(definition.settings.maxRunMinutes, 5, WORKFLOW_BOUNDS.maxRunMinutes)) error('invalid_run_limit', 'The run time limit must be between 5 minutes and 7 days.')
  if (definition.settings.maxCostUsd !== null && !inRange(definition.settings.maxCostUsd, 0.01, WORKFLOW_BOUNDS.maxCostUsd)) {
    error('invalid_cost_limit', `The cost limit must be between $0.01 and $${WORKFLOW_BOUNDS.maxCostUsd}.`)
  }

  // --- Structure ---------------------------------------------------------------
  const triggers = definition.nodes.filter((node) => node.type === 'trigger')
  if (triggers.length === 0) error('missing_trigger', 'Add a trigger: every workflow starts with one.')
  if (triggers.length > 1) error('multiple_triggers', 'A workflow has exactly one trigger.')
  if (!definition.nodes.some((node) => node.type === 'end')) error('missing_end', 'Add an end step so runs finish with a result.')

  const seenEdges = new Set<string>()
  const edgeIds = new Set<string>()
  for (const edge of definition.edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (edgeIds.has(edge.id)) error('duplicate_connection_id', `Two connections share the id “${edge.id}”.`, { edgeId: edge.id })
    edgeIds.add(edge.id)
    if (!source || !target) {
      error('dangling_connection', 'A connection points to a step that doesn’t exist.', { edgeId: edge.id })
      continue
    }
    if (edge.source === edge.target) error('self_connection', `“${source.label || source.id}” can’t lead to itself.`, { edgeId: edge.id })
    if (target.type === 'trigger') error('into_trigger', 'Nothing can lead into the trigger.', { edgeId: edge.id })
    const allowed = NODE_TYPE_INFO[source.type]?.branches ?? []
    if (!allowed.includes(edge.branch ?? '')) {
      error(
        'invalid_branch',
        source.type === 'end'
          ? `“${source.label || source.id}” is an end step; nothing can follow it.`
          : `A ${NODE_TYPE_INFO[source.type].label.toLowerCase()} step can’t have a “${edge.branch ?? 'then'}” path.`,
        { edgeId: edge.id },
      )
    }
    const key = `${edge.source}→${edge.target}:${edge.branch ?? ''}`
    if (seenEdges.has(key)) error('duplicate_connection', `“${source.label || source.id}” connects to “${target.label || target.id}” twice.`, { edgeId: edge.id })
    seenEdges.add(key)
  }

  const index = indexGraph(definition)
  for (const node of definition.nodes) {
    const info = NODE_TYPE_INFO[node.type]
    if (!info) continue
    const branches = new Set(index.outgoing.get(node.id)!.map((edge) => edge.branch ?? ''))
    for (const required of info.requiredBranches) {
      if (!branches.has(required)) {
        error(
          'missing_path',
          required === ''
            ? `“${node.label || node.id}” doesn’t lead anywhere. Connect it to the next step or an end step.`
            : `“${node.label || node.id}” needs a “${required}” path.`,
          { nodeId: node.id },
        )
      }
    }
  }

  const order = topologicalOrder(index)
  if (!order) {
    const cycle = findCycle(index).map((id) => byId.get(id)?.label || id)
    error('cycle', `Steps can’t loop back: ${cycle.join(' → ')} → ${cycle[0] ?? ''}.`)
  }
  const trigger = triggers.length === 1 ? triggers[0]! : null
  const reachable = trigger ? reachableFrom(index, trigger.id) : new Set<string>()
  if (trigger) {
    for (const node of definition.nodes) {
      if (!reachable.has(node.id)) error('unreachable', `“${node.label || node.id}” can never run: nothing leads to it from the trigger.`, { nodeId: node.id })
    }
  }
  const doms = trigger && order ? dominators(index, trigger.id, order) : null

  // --- Steps -----------------------------------------------------------------------
  for (const node of definition.nodes) {
    const at = { nodeId: node.id }
    const name = node.label || node.id
    switch (node.type) {
      case 'trigger': {
        if (node.config.kind === 'schedule') {
          const checked = checkSchedule(node.config.cron, node.config.timezone, options.now ?? new Date())
          if (!checked.ok) error('invalid_schedule', checked.message, at)
          if (definition.inputs.some((input) => input.required)) error('schedule_with_inputs', 'A scheduled workflow can’t have required inputs: nobody is there to fill them in.', at)
        }
        break
      }
      case 'employee_task':
        validateEmployeeTask(node, { error, resource, warn }, context)
        break
      case 'tool_action':
        validateToolAction(node, definition, { error, resource, warn }, context)
        break
      case 'condition':
        if (!node.config.rules.length) error('missing_rule', `“${name}” needs at least one rule.`, at)
        if (node.config.rules.length > WORKFLOW_BOUNDS.rules) error('too_many_rules', `“${name}” can have up to ${WORKFLOW_BOUNDS.rules} rules.`, at)
        node.config.rules.forEach((rule, position) => {
          if (!rule.left.trim()) error('incomplete_rule', `Rule ${position + 1} of “${name}” needs a value to test.`, at)
          if (!UNARY_OPERATORS.includes(rule.operator) && !rule.right.trim()) error('incomplete_rule', `Rule ${position + 1} of “${name}” needs a value to compare with.`, at)
        })
        break
      case 'approval':
        if (!node.config.message.trim()) error('missing_message', `“${name}” needs a message telling the approver what to decide.`, at)
        if (!inRange(node.config.expiresInHours, 1, WORKFLOW_BOUNDS.expiresInHours)) error('invalid_expiry', `“${name}” must expire after 1 to ${WORKFLOW_BOUNDS.expiresInHours} hours.`, at)
        break
      case 'transform': {
        if (!node.config.fields.length) error('missing_field', `“${name}” needs at least one field.`, at)
        if (node.config.fields.length > WORKFLOW_BOUNDS.fields) error('too_many_fields', `“${name}” can have up to ${WORKFLOW_BOUNDS.fields} fields.`, at)
        const keys = new Set<string>()
        for (const field of node.config.fields) {
          if (!KEY_PATTERN.test(field.key)) error('invalid_field_key', `Field “${field.key}” in “${name}” should start with a lowercase letter and use only letters, numbers and _.`, at)
          else if (keys.has(field.key)) error('duplicate_field', `“${name}” has two fields called “${field.key}”.`, at)
          keys.add(field.key)
        }
        break
      }
      case 'delay':
        if (!Number.isInteger(node.config.minutes) || !inRange(node.config.minutes, 1, WORKFLOW_BOUNDS.delayMinutes)) error('invalid_delay', `“${name}” must wait between 1 minute and 7 days.`, at)
        break
      case 'end':
        break
    }

    // --- Data references --------------------------------------------------------
    for (const { where, template } of templatesOf(node)) {
      if (template.length > WORKFLOW_BOUNDS.template) error('template_too_long', `The ${where} of “${name}” is too long.`, at)
      if (hasStrayBraces(template)) error('stray_braces', `The ${where} of “${name}” has unmatched {{ or }}.`, at)
      for (const reference of referencesIn(template)) {
        if (isReferenceError(reference)) {
          error('invalid_reference', `In the ${where} of “${name}”: ${reference.message}`, at)
          continue
        }
        if (reference.kind === 'input') {
          if (!inputKeys.has(reference.key)) error('unknown_input', `“${name}” uses ${reference.raw}, but there is no input “${reference.key}”.`, at)
          continue
        }
        if (reference.kind !== 'step') continue
        const source = byId.get(reference.nodeId)
        if (!source) {
          error('unknown_step', `“${name}” uses ${reference.raw}, but there is no step “${reference.nodeId}”.`, at)
          continue
        }
        if (source.id === node.id) {
          error('self_reference', `“${name}” can’t use its own output.`, at)
          continue
        }
        if (doms && reachable.has(node.id)) {
          const runsFirst = doms.get(node.id)?.has(source.id) ?? false
          const onSuccessPath = runsFirst && reachableFrom(index, source.id, (edge) => edge.source === source.id && edge.branch === 'failure').has(node.id)
          if (!runsFirst) {
            error('reference_not_upstream', `“${name}” uses ${reference.raw}, but “${source.label || source.id}” doesn’t always run before it.`, at)
            continue
          }
          if (!onSuccessPath) {
            error('reference_on_failure_path', `“${name}” runs only when “${source.label || source.id}” fails, so its output isn’t available.`, at)
            continue
          }
        }
        const keys = outputKeysOf(source, context)
        if (keys && keys.length === 0) error('no_output', `“${source.label || source.id}” doesn’t produce an output; use {{inputs.…}} for run inputs.`, at)
        else if (keys && reference.path[0] && !keys.includes(reference.path[0])) {
          error('unknown_output', `“${source.label || source.id}” has no output “${reference.path[0]}”. Available: ${keys.join(', ')}.`, at)
        } else if (keys && !reference.path.length) {
          error('incomplete_reference', `${reference.raw} needs a field after “output”, for example ${reference.raw.replace(/\}\}$/, `.${keys[0]}}}`)}.`, at)
        }
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === 'error')
  return { valid: errors.length === 0, errors, warnings: issues.filter((issue) => issue.severity === 'warning') }
}

type Report = {
  error: (code: string, message: string, at?: { nodeId?: string }) => void
  resource: (code: string, message: string, at?: { nodeId?: string }) => void
  warn: (code: string, message: string, at?: { nodeId?: string }) => void
}

function validateRetry(retry: { maxAttempts: number; backoffSeconds: number }, name: string, at: { nodeId: string }, report: Report) {
  if (!Number.isInteger(retry.maxAttempts) || !inRange(retry.maxAttempts, 1, WORKFLOW_BOUNDS.maxAttempts)) report.error('invalid_retry', `“${name}” can try 1 to ${WORKFLOW_BOUNDS.maxAttempts} times.`, at)
  if (!inRange(retry.backoffSeconds, 0, WORKFLOW_BOUNDS.backoffSeconds)) report.error('invalid_retry', `“${name}” must wait 0 to ${WORKFLOW_BOUNDS.backoffSeconds} seconds between attempts.`, at)
}

function validateEmployeeTask(node: EmployeeTaskNode, report: Report, context?: BuilderContext) {
  const at = { nodeId: node.id }
  const name = node.label || node.id
  const { config } = node
  if (!config.employeeId) report.error('missing_employee', `Choose the employee for “${name}”.`, at)
  if (!config.instructions.trim()) report.error('missing_instructions', `“${name}” needs instructions for the employee.`, at)
  if (config.instructions.length > WORKFLOW_BOUNDS.instructions) report.error('instructions_too_long', `The instructions of “${name}” are too long.`, at)
  if (!Number.isInteger(config.timeoutMinutes) || !inRange(config.timeoutMinutes, 5, WORKFLOW_BOUNDS.timeoutMinutes)) report.error('invalid_timeout', `“${name}” must have a deadline between 5 minutes and 7 days.`, at)
  if (config.outputs.length > WORKFLOW_BOUNDS.outputs) report.error('too_many_outputs', `“${name}” can ask for up to ${WORKFLOW_BOUNDS.outputs} values.`, at)
  const keys = new Set<string>()
  for (const output of config.outputs) {
    if (!KEY_PATTERN.test(output.key) || ['summary', 'status'].includes(output.key)) report.error('invalid_output_key', `Output “${output.key}” of “${name}” isn’t a valid name (and summary/status are reserved).`, at)
    else if (keys.has(output.key)) report.error('duplicate_output', `“${name}” asks for “${output.key}” twice.`, at)
    keys.add(output.key)
    if (!output.description.trim()) report.warn('missing_output_description', `Describe the value “${output.key}” so the employee knows what to report.`, at)
  }
  validateRetry(config.retry, name, at, report)
  if (context && config.employeeId) {
    const employee = context.employees.find((item) => item.id === config.employeeId)
    if (!employee) report.error('unknown_employee', `The employee chosen for “${name}” isn’t in this workspace.`, at)
    else if (employee.status !== 'active' || !employee.activeVersionId) report.resource('employee_not_active', `${employee.name} isn’t active. Only an active employee can work in a workflow.`, at)
  }
}

function validateToolAction(node: ToolActionNode, definition: WorkflowDefinition, report: Report, context?: BuilderContext) {
  const at = { nodeId: node.id }
  const name = node.label || node.id
  const { config } = node
  if (!config.toolKey) report.error('missing_tool', `Choose the action for “${name}”.`, at)
  if (config.input.length > WORKFLOW_BOUNDS.mappings) report.error('too_many_mappings', `“${name}” maps too many fields.`, at)
  const fields = new Set<string>()
  for (const mapping of config.input) {
    if (!mapping.field.trim()) report.error('missing_field_name', `A field in “${name}” has no name.`, at)
    else if (fields.has(mapping.field)) report.error('duplicate_mapping', `“${name}” maps “${mapping.field}” twice.`, at)
    fields.add(mapping.field)
  }
  validateRetry(config.retry, name, at, report)
  if (!context || !config.toolKey) return
  const tool = context.tools.find((item) => item.key === config.toolKey)
  if (!tool) {
    report.error('unknown_tool', `“${config.toolKey}” isn’t an action Nexefiy has.`, at)
    return
  }
  for (const mapping of config.input) {
    if (mapping.field && tool.fields.length && !tool.fields.some((field) => field.name === mapping.field)) report.error('unknown_field', `${tool.title} has no field “${mapping.field}”.`, at)
  }
  for (const field of tool.fields) {
    if (field.required && !config.input.some((mapping) => mapping.field === field.name && mapping.value.trim())) report.error('missing_required_field', `“${name}” must fill in “${field.name}”.`, at)
  }
  if (!config.integrationId) {
    report.error('missing_connection', `Choose which ${tool.providerName} connection “${name}” uses.`, at)
  } else {
    const connection = context.connections.find((item) => item.id === config.integrationId)
    if (!connection || connection.provider !== tool.provider) report.error('unknown_connection', `The connection chosen for “${name}” isn’t a ${tool.providerName} connection in this workspace.`, at)
    else if (connection.status !== 'connected') report.resource('connection_not_connected', `The ${tool.providerName} connection “${connection.label}” isn’t connected.`, at)
  }
  if (tool.risk !== 'read' && !config.requireApproval && tool.approval === 'none' && !approvedBeforehand(definition, node.id)) {
    report.warn('write_without_approval', `“${name}” changes data in ${tool.providerName} and nobody reviews it first unless the connection or a policy requires approval. Add an approval step or turn on “Always ask for approval”.`, at)
  }
}

export interface ReferenceOption {
  /** What to insert, e.g. {{steps.review.output.summary}}. */
  value: string
  label: string
  group: string
}

/**
 * The references a step may use: run inputs, run facts, and the outputs of
 * steps that always run before it (on their success path). The editor offers
 * these so nobody has to type a reference by hand.
 */
export function referencesAvailableTo(definition: WorkflowDefinition, nodeId: string, context?: BuilderContext): ReferenceOption[] {
  const options: ReferenceOption[] = definition.inputs
    .filter((input) => input.key)
    .map((input) => ({ value: `{{inputs.${input.key}}}`, label: input.label || input.key, group: 'Run inputs' }))
  options.push({ value: '{{run.id}}', label: 'Run id', group: 'Run' }, { value: '{{run.startedAt}}', label: 'Run start time', group: 'Run' })
  const index = indexGraph(definition)
  const order = topologicalOrder(index)
  const trigger = definition.nodes.find((node) => node.type === 'trigger')
  if (!order || !trigger) return options
  const doms = dominators(index, trigger.id, order).get(nodeId)
  if (!doms) return options
  for (const id of order) {
    if (id === nodeId || !doms.has(id)) continue
    const node = definition.nodes.find((item) => item.id === id)!
    const onSuccessPath = reachableFrom(index, id, (edge) => edge.source === id && edge.branch === 'failure').has(nodeId)
    if (!onSuccessPath) continue
    for (const key of outputKeysOf(node, context) ?? []) {
      options.push({ value: `{{steps.${id}.output.${key}}}`, label: key, group: node.label || id })
    }
  }
  return options
}

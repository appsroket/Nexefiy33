// Zod schemas for workflows (server only; client components use the
// Zod-free modules beside this one). The definition schema is the shape every
// saved draft and activated version must have; validation.ts then checks what
// the shape alone can't. Run inputs are validated against the inputs the
// version declares.

import { z } from 'zod'

import {
  APPROVER_ROLES,
  BRANCHES,
  CONDITION_OPERATORS,
  INPUT_TYPES,
  KEY_PATTERN,
  NODE_ID_PATTERN,
  TRANSFORM_FORMATS,
  TRIGGER_KINDS,
  WORKFLOW_BOUNDS as B,
  type WorkflowDefinition,
  type WorkflowInput,
  type WorkflowLayout,
} from './types'

const template = z.string().max(B.template)
const nodeId = z.string().regex(NODE_ID_PATTERN)
const key = z.string().max(40)
const retry = z.object({ maxAttempts: z.number().int().min(1).max(B.maxAttempts), backoffSeconds: z.number().int().min(0).max(B.backoffSeconds) })
const label = z.string().max(B.label)
const id = z.string().max(64)

const triggerConfig = z.object({ kind: z.enum(TRIGGER_KINDS), cron: z.string().max(100), timezone: z.string().max(64) })
const employeeTaskConfig = z.object({
  employeeId: id,
  employeeVersionId: z.uuid().optional(),
  instructions: z.string().max(B.instructions),
  outputs: z.array(z.object({ key, description: z.string().max(300) })).max(B.outputs),
  timeoutMinutes: z.number().int().min(5).max(B.timeoutMinutes),
  requireVerified: z.boolean(),
  retry,
})
const toolActionConfig = z.object({
  toolKey: z.string().max(100),
  integrationId: id,
  input: z.array(z.object({ field: z.string().max(64), value: template })).max(B.mappings),
  requireApproval: z.boolean(),
  retry,
})
const conditionConfig = z.object({
  match: z.enum(['all', 'any']),
  rules: z.array(z.object({ left: template, operator: z.enum(CONDITION_OPERATORS), right: template })).max(B.rules),
})
const approvalConfig = z.object({ message: template, approverRole: z.enum(APPROVER_ROLES), expiresInHours: z.number().int().min(1).max(B.expiresInHours) })
const transformConfig = z.object({ fields: z.array(z.object({ key, value: template, format: z.enum(TRANSFORM_FORMATS) })).max(B.fields) })
const delayConfig = z.object({ minutes: z.number().int().min(1).max(B.delayMinutes) })
const endConfig = z.object({ status: z.enum(['succeeded', 'failed']), summary: template })

const node = z.discriminatedUnion('type', [
  z.object({ id: nodeId, type: z.literal('trigger'), label, config: triggerConfig }),
  z.object({ id: nodeId, type: z.literal('employee_task'), label, config: employeeTaskConfig }),
  z.object({ id: nodeId, type: z.literal('tool_action'), label, config: toolActionConfig }),
  z.object({ id: nodeId, type: z.literal('condition'), label, config: conditionConfig }),
  z.object({ id: nodeId, type: z.literal('approval'), label, config: approvalConfig }),
  z.object({ id: nodeId, type: z.literal('transform'), label, config: transformConfig }),
  z.object({ id: nodeId, type: z.literal('delay'), label, config: delayConfig }),
  z.object({ id: nodeId, type: z.literal('end'), label, config: endConfig }),
])

export const workflowDefinitionSchema = z.object({
  inputs: z
    .array(z.object({ key: z.string().regex(KEY_PATTERN), label: z.string().min(1).max(B.label), type: z.enum(INPUT_TYPES), required: z.boolean(), description: z.string().max(300) }))
    .max(B.inputs),
  nodes: z.array(node).min(1).max(B.nodes),
  edges: z.array(z.object({ id: z.string().min(1).max(64), source: nodeId, target: nodeId, branch: z.enum(BRANCHES).optional() })).max(B.edges),
  settings: z.object({ maxRunMinutes: z.number().int().min(5).max(B.maxRunMinutes), maxCostUsd: z.number().positive().max(B.maxCostUsd).nullable() }),
}) satisfies z.ZodType<WorkflowDefinition>

export const workflowLayoutSchema = z
  .record(nodeId, z.object({ x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000) }))
  .refine((value) => Object.keys(value).length <= B.nodes, 'Too many positions.') satisfies z.ZodType<WorkflowLayout>

export const workflowMetaSchema = z.object({
  name: z.string().trim().min(1, 'Give the workflow a name.').max(B.name),
  description: z.string().trim().max(B.description),
})

export function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

/** The schema for a run's inputs: declared keys only, each with its type; required ones must be present. */
export function runInputSchema(inputs: readonly WorkflowInput[]) {
  const shape: Record<string, z.ZodType> = {}
  for (const input of inputs) {
    let field: z.ZodType
    switch (input.type) {
      case 'number':
        field = z.coerce.number().finite()
        break
      case 'boolean':
        field = z.preprocess((value) => (value === 'true' || value === 'on' ? true : value === 'false' || value === '' ? false : value), z.boolean())
        break
      case 'email':
        field = z.string().trim().toLowerCase().pipe(z.email().max(254))
        break
      case 'long_text':
        field = z.string().trim().max(5000)
        break
      default:
        field = z.string().trim().max(500)
    }
    if (!input.required) {
      field = z.preprocess((value) => (value === '' || value === null ? undefined : value), field.optional())
    } else if (input.type !== 'boolean') {
      field = z.preprocess((value) => (value === '' ? undefined : value), field)
    }
    shape[input.key] = field
  }
  return z.strictObject(shape)
}

// --- What the generator's model proposes -----------------------------------------
//
// Flat and small so structured output stays reliable; normalized into a
// definition (factory.normalizeDefinition) and then validated like anything
// else. Step-specific fields are optional and ignored where they don't apply.

const proposalStep = z.object({
  id: z.string().max(64),
  type: z.enum(['trigger', 'employee_task', 'tool_action', 'condition', 'approval', 'transform', 'delay', 'end']),
  label: z.string().max(B.label),
  employeeId: z.string().max(64).optional(),
  instructions: z.string().max(B.instructions).optional(),
  outputs: z.array(z.object({ key: z.string().max(40), description: z.string().max(300) })).max(B.outputs).optional(),
  toolKey: z.string().max(100).optional(),
  integrationId: z.string().max(64).optional(),
  inputMappings: z.array(z.object({ field: z.string().max(64), value: template })).max(B.mappings).optional(),
  requireApproval: z.boolean().optional(),
  conditionMatch: z.enum(['all', 'any']).optional(),
  conditionRules: z.array(z.object({ left: template, operator: z.enum(CONDITION_OPERATORS), right: template })).max(B.rules).optional(),
  approvalMessage: template.optional(),
  approverRole: z.enum(APPROVER_ROLES).optional(),
  transformFields: z.array(z.object({ key: z.string().max(40), value: template, format: z.enum(TRANSFORM_FORMATS) })).max(B.fields).optional(),
  delayMinutes: z.number().int().optional(),
  endStatus: z.enum(['succeeded', 'failed']).optional(),
  endSummary: template.optional(),
  scheduleCron: z.string().max(100).optional(),
  scheduleTimezone: z.string().max(64).optional(),
})

export const workflowProposalSchema = z.object({
  name: z.string().max(B.name),
  description: z.string().max(B.description),
  inputs: z.array(z.object({ key: z.string().max(40), label: z.string().max(B.label), type: z.enum(INPUT_TYPES), required: z.boolean(), description: z.string().max(300) })).max(B.inputs),
  steps: z.array(proposalStep).max(B.nodes),
  connections: z.array(z.object({ from: z.string().max(64), to: z.string().max(64), branch: z.enum(['then', ...BRANCHES]) })).max(B.edges),
  unsupportedRequests: z.array(z.string().max(300)).max(10),
})
export type WorkflowProposal = z.infer<typeof workflowProposalSchema>

// Zod schemas for employee configuration (schema version 2) and test cases.
// Server code only; client components use ./types.ts. The database validates
// the same shape (private.employee_config_is_valid); keep both in sync.

import { z } from 'zod'

import {
  CONFIG_BOUNDS,
  DEPARTMENTS,
  ESCALATION_BEHAVIORS,
  KNOWLEDGE_ACCESS,
  MODEL_EFFORTS,
  MODEL_TIERS,
  TOOL_APPROVALS,
  type EmployeeConfig,
  type EmployeeDraft,
  type TestExpectations,
} from './types'

const TOOL_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const SKILL_KEY = /^[a-z][a-z0-9_.-]{1,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const item = z.string().trim().min(1).max(CONFIG_BOUNDS.listItem)
const list = (max: number, min = 0) => z.array(item).min(min).max(max)
const bounded = (bounds: { min: number; max: number }) => z.number().int().min(bounds.min).max(bounds.max)

export const employeeConfigSchema = z
  .object({
    profile: z.object({
      name: z.string().trim().min(1, 'Give the employee a name.').max(CONFIG_BOUNDS.name),
      department: z.enum(DEPARTMENTS),
      description: z.string().trim().max(CONFIG_BOUNDS.description),
      templateKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
    }),
    responsibilities: list(CONFIG_BOUNDS.responsibilities, 1),
    skills: z.array(z.string().regex(SKILL_KEY)).max(CONFIG_BOUNDS.skills),
    tools: z
      .array(
        z.object({
          toolKey: z.string().regex(TOOL_KEY),
          integrationId: z.string().regex(UUID).nullable(),
          approval: z.enum(TOOL_APPROVALS),
        }),
      )
      .max(CONFIG_BOUNDS.tools),
    knowledge: z.object({
      access: z.enum(KNOWLEDGE_ACCESS),
      sourceIds: z.array(z.string().regex(UUID)).max(CONFIG_BOUNDS.sources),
      maxPassages: bounded(CONFIG_BOUNDS.maxPassages),
    }),
    model: z.object({
      provider: z.literal('anthropic'),
      tier: z.enum(MODEL_TIERS),
      effort: z.enum(MODEL_EFFORTS),
      maxOutputTokens: bounded(CONFIG_BOUNDS.maxOutputTokens),
    }),
    successCriteria: list(CONFIG_BOUNDS.successCriteria, 1),
    allowedActions: list(CONFIG_BOUNDS.actions),
    prohibitedActions: list(CONFIG_BOUNDS.actions),
    escalation: z.object({
      when: list(CONFIG_BOUNDS.escalationWhen),
      behavior: z.enum(ESCALATION_BEHAVIORS),
      notes: z.string().trim().max(CONFIG_BOUNDS.escalationNotes),
    }),
    limits: z.object({
      maxTurnsPerTask: bounded(CONFIG_BOUNDS.maxTurnsPerTask),
      maxToolCallsPerTask: bounded(CONFIG_BOUNDS.maxToolCallsPerTask),
      maxCostUsdPerTask: z.number().min(CONFIG_BOUNDS.maxCostUsdPerTask.min).max(CONFIG_BOUNDS.maxCostUsdPerTask.max),
      maxRuntimeSeconds: bounded(CONFIG_BOUNDS.maxRuntimeSeconds),
    }),
    budget: z.object({
      monthlyUsd: z.number().min(CONFIG_BOUNDS.monthlyUsd.min).max(CONFIG_BOUNDS.monthlyUsd.max),
    }),
  })
  .superRefine((config, context) => {
    const keys = config.tools.map((tool) => tool.toolKey)
    keys.forEach((key, index) => {
      if (keys.indexOf(key) !== index) context.addIssue({ code: 'custom', path: ['tools', index], message: `${key} is listed twice.` })
    })
    if (new Set(config.skills).size !== config.skills.length) context.addIssue({ code: 'custom', path: ['skills'], message: 'A skill is listed twice.' })
    if (new Set(config.knowledge.sourceIds).size !== config.knowledge.sourceIds.length) {
      context.addIssue({ code: 'custom', path: ['knowledge', 'sourceIds'], message: 'A knowledge source is listed twice.' })
    }
    if (config.knowledge.access === 'selected' && config.knowledge.sourceIds.length === 0) {
      context.addIssue({ code: 'custom', path: ['knowledge', 'sourceIds'], message: 'Choose at least one knowledge source, or allow all of them.' })
    }
  }) satisfies z.ZodType<EmployeeConfig>

export const instructionsSchema = z.string().trim().min(1, 'Write instructions for the employee.').max(CONFIG_BOUNDS.instructions)

export const employeeDraftSchema = z.object({
  instructions: instructionsSchema,
  config: employeeConfigSchema,
}) satisfies z.ZodType<EmployeeDraft>

const toolList = z.array(z.string().regex(TOOL_KEY)).max(10)

export const testExpectationsSchema = z
  .object({
    mustUseTools: toolList.optional(),
    mustNotUseTools: toolList.optional(),
    mustRequestApproval: toolList.optional(),
    replyMustMention: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    mustEscalate: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<TestExpectations>

export const testCaseSchema = z.object({
  name: z.string().trim().min(1, 'Name the test.').max(120),
  input: z.string().trim().min(1, 'Write the request to test.').max(4000),
  expectations: testExpectationsSchema,
})

/** Issues as "path: message" pairs for forms. */
export function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

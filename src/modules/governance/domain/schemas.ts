// Zod schemas for what admins submit: policy documents (version 2), policy
// settings and retention. Mirrors private.policy_document_is_valid; the
// database checks every stored document again.

import { z } from 'zod'

import { RISK_LEVELS } from '@/modules/integrations/domain/types'

import { POLICY_ACTORS } from './policy'
import { ACTION_CATEGORIES, RISK_TIERS } from './risk'

const toolPattern = z
  .string()
  .trim()
  .max(100)
  .regex(/^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/, 'Use a tool key such as hubspot.contacts.upsert, a provider such as hubspot.*, or *.')

const hours = z.number().int().min(1, 'At least 1 hour.').max(720, 'At most 30 days.')

export const policyRuleSchema = z
  .object({
    id: z.string().trim().max(64).optional(),
    description: z.string().trim().max(500).optional(),
    effect: z.enum(['allow', 'require_approval', 'deny']),
    toolKeys: z.array(toolPattern).max(100).optional(),
    categories: z.array(z.enum(ACTION_CATEGORIES)).optional(),
    tiers: z.array(z.enum(RISK_TIERS)).optional(),
    riskLevels: z.array(z.enum(RISK_LEVELS)).optional(),
    employeeIds: z.array(z.uuid()).max(200).optional(),
    actors: z.array(z.enum(POLICY_ACTORS)).optional(),
    approverRole: z.enum(['operator', 'admin', 'owner']).optional(),
    separateApprover: z.boolean().optional(),
    approvalExpiresInHours: hours.optional(),
  })
  .strict()
  .refine((rule) => rule.effect !== 'allow' || (rule.toolKeys?.length ?? 0) > 0, {
    message: 'An “allow” rule must name the actions it permits.',
    path: ['toolKeys'],
  })
  .refine((rule) => rule.effect === 'require_approval' || (!rule.approverRole && !rule.separateApprover && !rule.approvalExpiresInHours), {
    message: 'Approval settings only apply to “require approval” rules.',
    path: ['effect'],
  })

export const policyDocumentSchema = z
  .object({
    rules: z.array(policyRuleSchema).max(200),
    approvals: z.object({ expiresInHours: hours.optional(), separateApprover: z.boolean().optional() }).strict().optional(),
    tools: z.object({ allowlist: z.array(toolPattern).max(200).optional() }).strict().optional(),
    dataAccess: z.object({ blockedSourceIds: z.array(z.uuid()).max(500).optional(), requireSelectedSources: z.boolean().optional() }).strict().optional(),
    limits: z
      .object({
        maxTaskRuntimeSeconds: z.number().int().min(10).max(900).optional(),
        maxCostUsdPerTask: z.number().min(0.01).max(50).optional(),
        employeeMonthlyUsd: z.number().min(1).max(10_000).optional(),
        organizationMonthlyUsd: z.number().min(1).max(100_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type PolicyDocumentInput = z.infer<typeof policyDocumentSchema>

export const policySettingsSchema = z.object({
  name: z.string().trim().min(1, 'Name the policy.').max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => value || null),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(10_000),
})

const retentionDays = z.number().int().min(30, 'At least 30 days.').max(3650, 'At most 10 years.').nullable()

export const retentionSchema = z.object({
  evidenceDays: retentionDays,
  eventDays: retentionDays,
  payloadDays: retentionDays,
  hold: z.boolean(),
})

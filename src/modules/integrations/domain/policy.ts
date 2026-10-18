// Decides whether an integration action may run, needs approval, or is
// blocked. Pure. Inputs come from trusted server state: the connector's
// declared requirement (code), the connection's action setting (admins), and
// organization policies — never from a model or the browser.
//
// The result is the most restrictive of all applicable rules, so a policy can
// only make an action stricter than the connection setting, and an action
// declared "always needs approval" can never be relaxed.

import type { OrganizationRole } from '@/lib/supabase/types'

import type { ApprovalMode, ApprovalRequirement, RiskLevel } from './types'

const RANK: Record<ApprovalMode, number> = { allow: 0, require_approval: 1, deny: 2 }

export function mostRestrictive(...modes: (ApprovalMode | null | undefined)[]): ApprovalMode {
  return modes.reduce<ApprovalMode>((strictest, mode) => (mode && RANK[mode] > RANK[strictest] ? mode : strictest), 'allow')
}

export function defaultApprovalMode(requirement: ApprovalRequirement): ApprovalMode {
  return requirement === 'none' ? 'allow' : 'require_approval'
}

/** Approval modes an admin may choose for an action with this requirement. */
export function allowedApprovalModes(requirement: ApprovalRequirement, risk: RiskLevel): ApprovalMode[] {
  return requirement === 'always' || risk === 'sensitive' ? ['require_approval', 'deny'] : ['allow', 'require_approval', 'deny']
}

/** One rule of an organization policy document (schema version 1). */
export interface PolicyRule {
  id?: string
  effect: ApprovalMode
  toolKeys?: string[]
  riskLevels?: RiskLevel[]
  employeeIds?: string[]
  conditions?: Record<string, unknown>
}

export interface PolicyContext {
  toolKey: string
  risk: RiskLevel
  employeeId?: string | null
}

function toolKeyMatches(pattern: string, toolKey: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return toolKey.startsWith(pattern.slice(0, -1))
  return pattern === toolKey
}

/**
 * Whether a rule applies. Conditions aren't evaluated yet, so a rule with
 * conditions is treated as applying: that can only make an action stricter
 * when its effect is stricter, and it is never used to allow (fail closed).
 */
export function ruleApplies(rule: PolicyRule, context: PolicyContext): boolean {
  if (rule.toolKeys?.length && !rule.toolKeys.some((pattern) => toolKeyMatches(pattern, context.toolKey))) return false
  if (rule.riskLevels?.length && !rule.riskLevels.includes(context.risk)) return false
  if (rule.employeeIds?.length && !(context.employeeId && rule.employeeIds.includes(context.employeeId))) return false
  return true
}

export interface PolicyMatch {
  effect: ApprovalMode
  policyId: string
  ruleId?: string
}

export interface StoredPolicy {
  id: string
  name: string
  rules: PolicyRule[]
}

/** The strictest applicable rule across enabled policies, or null when none applies. */
export function evaluatePolicies(policies: readonly StoredPolicy[], context: PolicyContext): (PolicyMatch & { policyName: string }) | null {
  let strictest: (PolicyMatch & { policyName: string }) | null = null
  for (const policy of policies) {
    for (const rule of policy.rules) {
      if (!ruleApplies(rule, context)) continue
      const hasConditions = rule.conditions && Object.keys(rule.conditions).length > 0
      if (hasConditions && rule.effect === 'allow') continue
      if (!strictest || RANK[rule.effect] > RANK[strictest.effect]) {
        strictest = { effect: rule.effect, policyId: policy.id, policyName: policy.name, ...(rule.id ? { ruleId: rule.id } : {}) }
      }
    }
  }
  return strictest
}

export interface ActionDecisionInput {
  requirement: ApprovalRequirement
  risk: RiskLevel
  /** The connection's setting for this action, or null when none is stored. */
  connectionMode: ApprovalMode | null
  enabled: boolean
  policy: (PolicyMatch & { policyName: string }) | null
}

export interface ActionDecision {
  decision: ApprovalMode
  reason: string
  policyId: string | null
}

export function decideAction(input: ActionDecisionInput): ActionDecision {
  if (!input.enabled) return { decision: 'deny', reason: 'This action is turned off for the connection.', policyId: null }

  const declared = defaultApprovalMode(input.requirement)
  let base = input.connectionMode ?? declared
  let reason = input.connectionMode ? 'Connection setting for this action.' : 'Default for this action.'
  if ((input.requirement === 'always' || input.risk === 'sensitive') && base === 'allow') {
    base = 'require_approval'
    reason = 'This action always needs approval.'
  }

  if (input.policy && RANK[input.policy.effect] > RANK[base]) {
    return {
      decision: input.policy.effect,
      reason: `Workspace policy “${input.policy.policyName}”.`,
      policyId: input.policy.policyId,
    }
  }
  return { decision: base, reason, policyId: null }
}

/** Minimum role that may approve an action of this risk level. */
export function approverRoleFor(risk: RiskLevel): Exclude<OrganizationRole, 'viewer'> {
  return risk === 'write_external' || risk === 'sensitive' ? 'admin' : 'operator'
}

/** Minimum role that may ask for an action to run (it may still need approval). */
export const MIN_ROLE_TO_RUN_ACTIONS: OrganizationRole = 'operator'

/** Minimum role that may connect, disconnect and configure integrations. */
export const MIN_ROLE_TO_MANAGE_INTEGRATIONS: OrganizationRole = 'admin'

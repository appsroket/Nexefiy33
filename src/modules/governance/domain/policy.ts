// Workspace policy documents and how they combine. Pure and Zod-free (the
// editor's schema is in ./schemas.ts); the database validates every stored
// document (private.policy_document_is_valid).
//
// A document (schema version 2) holds:
//   rules       allow / require approval / deny, matched by tool key (exact,
//               "provider.*" or "*"), action category, risk tier, risk level,
//               employee and actor, with approval settings for the match;
//   approvals   default expiry and separate-approver requirement;
//   tools       an allowlist of tool keys AI work may use;
//   dataAccess  knowledge sources employees may never read, and whether
//               employees must name the sources they read;
//   limits      per-task runtime and cost, monthly spend per employee and
//               for the workspace.
//
// Enabled policies combine to the strictest result: the strictest matching
// rule, every allowlist at once, the union of blocked sources, the smallest
// limit. One thing can loosen: an "allow" rule that names an action exactly,
// in a policy last changed by a role allowed to authorize that action's risk
// tier, lets it run without approval (see decideAction in
// src/modules/integrations/domain/policy.ts).

import type { RiskLevel } from '@/modules/integrations/domain/types'

import { higherRole, roleAtLeast, RISK_TIER_INFO, tierOf, type ActionCategory, type ApproverRole, type RiskTier } from './risk'

export type PolicyEffect = 'allow' | 'require_approval' | 'deny'
export const POLICY_ACTORS = ['employee', 'workflow', 'person'] as const
export type PolicyActor = (typeof POLICY_ACTORS)[number]

export interface PolicyRule {
  id?: string
  description?: string
  effect: PolicyEffect
  toolKeys?: string[]
  categories?: ActionCategory[]
  tiers?: RiskTier[]
  riskLevels?: RiskLevel[]
  employeeIds?: string[]
  actors?: PolicyActor[]
  approverRole?: ApproverRole
  separateApprover?: boolean
  approvalExpiresInHours?: number
  /** Version 1 only; never evaluated (a rule with conditions never allows). */
  conditions?: Record<string, unknown>
}

export interface PolicyLimits {
  maxTaskRuntimeSeconds?: number
  maxCostUsdPerTask?: number
  employeeMonthlyUsd?: number
  organizationMonthlyUsd?: number
}

export interface PolicyDocument {
  rules: PolicyRule[]
  approvals?: { expiresInHours?: number; separateApprover?: boolean }
  tools?: { allowlist?: string[] }
  dataAccess?: { blockedSourceIds?: string[]; requireSelectedSources?: boolean }
  limits?: PolicyLimits
  /** Version 1. */
  defaults?: { approvalExpiresInHours?: number }
}

export interface StoredPolicy {
  id: string
  name: string
  revision: number
  schemaVersion: number
  /** Role of the person who made this revision; null when no member made it (it authorizes nothing). */
  authorizedRole: 'owner' | 'admin' | null
  document: PolicyDocument
}

export interface PolicyRow {
  id: string
  name: string
  revision?: number | null
  policy_schema_version?: number | null
  authorized_role?: string | null
  policy: unknown
}

export function storedPolicyFromRow(row: PolicyRow): StoredPolicy {
  const raw = (row.policy && typeof row.policy === 'object' ? row.policy : {}) as Partial<PolicyDocument>
  return {
    id: row.id,
    name: row.name,
    revision: row.revision ?? 1,
    schemaVersion: row.policy_schema_version ?? 1,
    authorizedRole: row.authorized_role === 'owner' || row.authorized_role === 'admin' ? row.authorized_role : null,
    document: { ...raw, rules: Array.isArray(raw.rules) ? raw.rules : [] },
  }
}

export function toolKeyMatches(pattern: string, toolKey: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return toolKey.startsWith(pattern.slice(0, -1))
  return pattern === toolKey
}

export interface RuleContext {
  toolKey: string
  risk: RiskLevel
  category?: ActionCategory
  actor?: PolicyActor
  employeeId?: string | null
}

/** Whether a rule applies. Unknown dimensions (no category given) never exclude a rule. */
export function ruleApplies(rule: PolicyRule, context: RuleContext): boolean {
  if (rule.toolKeys?.length && !rule.toolKeys.some((pattern) => toolKeyMatches(pattern, context.toolKey))) return false
  if (rule.riskLevels?.length && !rule.riskLevels.includes(context.risk)) return false
  if (rule.categories?.length && context.category && !rule.categories.includes(context.category)) return false
  if (rule.tiers?.length && context.category && !rule.tiers.includes(tierOf(context.category))) return false
  if (rule.employeeIds?.length && !(context.employeeId && rule.employeeIds.includes(context.employeeId))) return false
  if (rule.actors?.length && context.actor && !rule.actors.includes(context.actor)) return false
  return true
}

const RANK: Record<PolicyEffect, number> = { allow: 0, require_approval: 1, deny: 2 }

export interface PolicyRef {
  policyId: string
  policyName: string
  policyRevision: number
  ruleId?: string
}

export interface RuleOutcome {
  /** The strictest restricting rule (require approval or deny), if any. */
  restriction: (PolicyRef & { effect: 'require_approval' | 'deny' }) | null
  /** An "allow" that may waive approval: exact tool key, no conditions, authorized for the tier. */
  authorizedAllow: PolicyRef | null
  /** An "allow" that matched but can't waive approval, and why. */
  unauthorizedAllow: (PolicyRef & { reason: string }) | null
  approverRole: ApproverRole | null
  separateApprover: boolean
  approvalHours: number | null
}

function ref(policy: StoredPolicy, rule: PolicyRule): PolicyRef {
  return { policyId: policy.id, policyName: policy.name, policyRevision: policy.revision, ...(rule.id ? { ruleId: rule.id } : {}) }
}

export function evaluateRules(policies: readonly StoredPolicy[], context: RuleContext): RuleOutcome {
  const outcome: RuleOutcome = { restriction: null, authorizedAllow: null, unauthorizedAllow: null, approverRole: null, separateApprover: false, approvalHours: null }
  const tier = context.category ? tierOf(context.category) : null
  for (const policy of policies) {
    for (const rule of policy.document.rules) {
      if (!ruleApplies(rule, context)) continue
      if (rule.effect === 'allow') {
        const hasConditions = rule.conditions && Object.keys(rule.conditions).length > 0
        const exact = rule.toolKeys?.includes(context.toolKey) ?? false
        const authorizer = tier ? RISK_TIER_INFO[tier].authorizerRole : 'admin'
        if (!hasConditions && exact && roleAtLeast(policy.authorizedRole, authorizer)) {
          outcome.authorizedAllow ??= ref(policy, rule)
        } else {
          outcome.unauthorizedAllow ??= {
            ...ref(policy, rule),
            reason: hasConditions
              ? 'its rule has conditions, which aren’t evaluated'
              : !exact
                ? 'it doesn’t name this action exactly'
                : `it wasn’t last changed by ${authorizer === 'owner' ? 'an owner' : 'an admin or owner'}`,
          }
        }
        continue
      }
      if (!outcome.restriction || RANK[rule.effect] > RANK[outcome.restriction.effect]) {
        outcome.restriction = { ...ref(policy, rule), effect: rule.effect }
      }
      if (rule.effect === 'require_approval') {
        if (rule.approverRole) outcome.approverRole = outcome.approverRole ? higherRole(outcome.approverRole, rule.approverRole) : rule.approverRole
        if (rule.separateApprover) outcome.separateApprover = true
        if (rule.approvalExpiresInHours) outcome.approvalHours = Math.min(outcome.approvalHours ?? Infinity, rule.approvalExpiresInHours)
      }
    }
  }
  return outcome
}

/**
 * The strictest matching rule, allow included (for checks that aren't
 * actions, such as workflow hand-offs), or null when none applies.
 */
export function evaluatePolicies(policies: readonly StoredPolicy[], context: RuleContext): (PolicyRef & { effect: PolicyEffect }) | null {
  let strictest: (PolicyRef & { effect: PolicyEffect }) | null = null
  for (const policy of policies) {
    for (const rule of policy.document.rules) {
      if (!ruleApplies(rule, context)) continue
      const hasConditions = rule.conditions && Object.keys(rule.conditions).length > 0
      if (hasConditions && rule.effect === 'allow') continue
      if (!strictest || RANK[rule.effect] > RANK[strictest.effect]) strictest = { ...ref(policy, rule), effect: rule.effect }
    }
  }
  return strictest
}

export interface GovernanceControls {
  /** Every allowlist that applies (a tool must be on all of them). */
  allowlists: { policyName: string; patterns: string[] }[]
  blockedSourceIds: string[]
  requireSelectedSources: boolean
  limits: PolicyLimits
  approvals: { expiresInHours: number | null; separateApprover: boolean }
}

function minDefined(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current
  return current === undefined ? next : Math.min(current, next)
}

export function combineControls(policies: readonly StoredPolicy[]): GovernanceControls {
  const controls: GovernanceControls = { allowlists: [], blockedSourceIds: [], requireSelectedSources: false, limits: {}, approvals: { expiresInHours: null, separateApprover: false } }
  const blocked = new Set<string>()
  for (const policy of policies) {
    const document = policy.document
    if (policy.schemaVersion >= 2 && Array.isArray(document.tools?.allowlist)) controls.allowlists.push({ policyName: policy.name, patterns: document.tools.allowlist })
    for (const id of document.dataAccess?.blockedSourceIds ?? []) blocked.add(id)
    if (document.dataAccess?.requireSelectedSources) controls.requireSelectedSources = true
    for (const key of ['maxTaskRuntimeSeconds', 'maxCostUsdPerTask', 'employeeMonthlyUsd', 'organizationMonthlyUsd'] as const) {
      const value = minDefined(controls.limits[key], document.limits?.[key])
      if (value !== undefined) controls.limits[key] = value
    }
    const hours = document.approvals?.expiresInHours ?? document.defaults?.approvalExpiresInHours
    if (hours) controls.approvals.expiresInHours = Math.min(controls.approvals.expiresInHours ?? Infinity, hours)
    if (document.approvals?.separateApprover) controls.approvals.separateApprover = true
  }
  controls.blockedSourceIds = [...blocked]
  return controls
}

/** Null when the tool may be used; otherwise the policy whose allowlist leaves it out. */
export function allowlistBlocking(controls: GovernanceControls, toolKey: string): string | null {
  const blocking = controls.allowlists.find((list) => !list.patterns.some((pattern) => toolKeyMatches(pattern, toolKey)))
  return blocking?.policyName ?? null
}

export type KnowledgeAccess = 'none' | 'all' | 'selected'

/**
 * What an employee may read once policy applies: blocked sources are removed,
 * and when sources must be named, "all" reads nothing.
 */
export function effectiveKnowledgeAccess(
  knowledge: { access: KnowledgeAccess; sourceIds: string[] },
  controls: Pick<GovernanceControls, 'blockedSourceIds' | 'requireSelectedSources'>,
): { access: KnowledgeAccess; sourceIds: string[]; excludeSourceIds: string[]; restricted: string | null } {
  if (knowledge.access === 'none') return { access: 'none', sourceIds: [], excludeSourceIds: [], restricted: null }
  if (knowledge.access === 'all') {
    if (controls.requireSelectedSources) {
      return { access: 'none', sourceIds: [], excludeSourceIds: [], restricted: 'Workspace policy requires employees to name the sources they read.' }
    }
    return { access: 'all', sourceIds: [], excludeSourceIds: controls.blockedSourceIds, restricted: controls.blockedSourceIds.length ? 'Some sources are blocked by workspace policy.' : null }
  }
  const allowed = knowledge.sourceIds.filter((id) => !controls.blockedSourceIds.includes(id))
  const removed = allowed.length !== knowledge.sourceIds.length
  if (!allowed.length) return { access: 'none', sourceIds: [], excludeSourceIds: [], restricted: 'Workspace policy blocks every source this employee may read.' }
  return { access: 'selected', sourceIds: allowed, excludeSourceIds: [], restricted: removed ? 'Some sources are blocked by workspace policy.' : null }
}

/** Employee limits after workspace policy (each can only get smaller). */
export function effectiveLimits<L extends { maxRuntimeSeconds: number; maxCostUsdPerTask: number }>(limits: L, controls: Pick<GovernanceControls, 'limits'>): L {
  return {
    ...limits,
    maxRuntimeSeconds: Math.min(limits.maxRuntimeSeconds, controls.limits.maxTaskRuntimeSeconds ?? Infinity),
    maxCostUsdPerTask: Math.min(limits.maxCostUsdPerTask, controls.limits.maxCostUsdPerTask ?? Infinity),
  }
}

/** Why workspace policy stops a configuration from being activated (empty when it doesn't). */
export function activationPolicyIssues(
  config: { tools: { toolKey: string }[]; knowledge: { access: KnowledgeAccess; sourceIds: string[] } },
  controls: GovernanceControls,
): string[] {
  const issues: string[] = []
  for (const grant of config.tools) {
    const blocking = allowlistBlocking(controls, grant.toolKey)
    if (blocking) issues.push(`Workspace policy “${blocking}” doesn’t allow ${grant.toolKey}.`)
  }
  if (config.knowledge.access === 'all' && controls.requireSelectedSources) {
    issues.push('Workspace policy requires employees to name the knowledge sources they read.')
  }
  if (config.knowledge.access === 'selected' && config.knowledge.sourceIds.length && config.knowledge.sourceIds.every((id) => controls.blockedSourceIds.includes(id))) {
    issues.push('Workspace policy blocks every knowledge source this employee reads.')
  }
  return issues
}

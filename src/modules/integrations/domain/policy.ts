// Decides whether an integration action may run, needs approval, or is
// blocked, and on what terms an approval is valid. Pure. Inputs come from
// trusted server state: the connector's declared requirement and category
// (code), the connection's action setting (admins), and workspace policies —
// never from a model or the browser.
//
// The result is the most restrictive of all applicable rules, with one
// exception: a consequential action (see governance/domain/risk.ts) needs
// approval unless a policy explicitly permits it — an "allow" rule naming the
// action exactly, last changed by a role allowed to authorize its risk tier.
// A connection setting alone can't waive approval for a consequential action,
// and an action declared "always needs approval" can never be relaxed.

import type { OrganizationRole } from '@/lib/supabase/types'
import { allowlistBlocking, combineControls, evaluateRules, type PolicyActor, type StoredPolicy } from '@/modules/governance/domain/policy'
import { higherRole, isConsequential, RISK_TIER_INFO, tierOf, type ActionCategory, type ApproverRole, type RiskTier } from '@/modules/governance/domain/risk'

import type { ApprovalMode, ApprovalRequirement, RiskLevel } from './types'

export { evaluatePolicies, ruleApplies, type PolicyRule, type StoredPolicy } from '@/modules/governance/domain/policy'

const RANK: Record<ApprovalMode, number> = { allow: 0, require_approval: 1, deny: 2 }

export function mostRestrictive(...modes: (ApprovalMode | null | undefined)[]): ApprovalMode {
  return modes.reduce<ApprovalMode>((strictest, mode) => (mode && RANK[mode] > RANK[strictest] ? mode : strictest), 'allow')
}

export function defaultApprovalMode(requirement: ApprovalRequirement): ApprovalMode {
  return requirement === 'none' ? 'allow' : 'require_approval'
}

/** Approval modes an admin may choose on a connection. Consequential actions can't be set to run without approval there. */
export function allowedApprovalModes(requirement: ApprovalRequirement, risk: RiskLevel, category: ActionCategory): ApprovalMode[] {
  return requirement === 'always' || risk === 'sensitive' || isConsequential(category) ? ['require_approval', 'deny'] : ['allow', 'require_approval', 'deny']
}

/** Minimum role that may approve an action of this (connector) risk level. */
export function approverRoleFor(risk: RiskLevel): ApproverRole {
  return risk === 'write_external' || risk === 'sensitive' ? 'admin' : 'operator'
}

export interface ActionDecisionInput {
  toolKey: string
  requirement: ApprovalRequirement
  risk: RiskLevel
  category: ActionCategory
  /** The connection's setting for this action, or null when none is stored. */
  connectionMode: ApprovalMode | null
  enabled: boolean
  /** Enabled workspace policies, in priority order. */
  policies: readonly StoredPolicy[]
  actor: PolicyActor
  employeeId?: string | null
}

export interface ActionDecision {
  decision: ApprovalMode
  reason: string
  policyId: string | null
  policyRevision: number | null
  category: ActionCategory
  tier: RiskTier
  /** Terms for an approval, when one is needed. */
  approverRole: ApproverRole
  separateApprover: boolean
  approvalHours: number
}

export function decideAction(input: ActionDecisionInput): ActionDecision {
  const tier = tierOf(input.category)
  const tierInfo = RISK_TIER_INFO[tier]
  const controls = combineControls(input.policies)
  const outcome = evaluateRules(input.policies, { toolKey: input.toolKey, risk: input.risk, category: input.category, actor: input.actor, employeeId: input.employeeId ?? null })

  const terms = {
    category: input.category,
    tier,
    approverRole: higherRole(higherRole(tierInfo.approverRole, approverRoleFor(input.risk)), outcome.approverRole ?? 'operator'),
    separateApprover: tierInfo.separateApprover || controls.approvals.separateApprover || outcome.separateApprover,
    approvalHours: Math.min(tierInfo.maxApprovalHours, controls.approvals.expiresInHours ?? Infinity, outcome.approvalHours ?? Infinity),
  }
  const result = (decision: ApprovalMode, reason: string, policy: { policyId: string; policyRevision: number } | null = null): ActionDecision => ({
    decision,
    reason,
    policyId: policy?.policyId ?? null,
    policyRevision: policy?.policyRevision ?? null,
    ...terms,
  })

  if (!input.enabled) return result('deny', 'This action is turned off for the connection.')
  if (input.actor !== 'person') {
    const blocking = allowlistBlocking(controls, input.toolKey)
    if (blocking) {
      const policy = input.policies.find((item) => item.name === blocking)
      return result('deny', `Workspace policy “${blocking}” doesn’t list this tool for AI work.`, policy ? { policyId: policy.id, policyRevision: policy.revision } : null)
    }
  }

  let base = input.connectionMode ?? defaultApprovalMode(input.requirement)
  let reason = input.connectionMode ? 'Connection setting for this action.' : 'Default for this action.'
  const neverWaived = input.requirement === 'always' || input.risk === 'sensitive'
  if (neverWaived && base === 'allow') {
    base = 'require_approval'
    reason = 'This action always needs approval.'
  } else if (isConsequential(input.category) && base === 'allow') {
    base = 'require_approval'
    reason = `${tierInfo.label}-risk actions need approval unless a workspace policy explicitly permits them.`
  }

  if (outcome.restriction && RANK[outcome.restriction.effect] >= RANK[base]) {
    return result(outcome.restriction.effect, `Workspace policy “${outcome.restriction.policyName}”.`, outcome.restriction)
  }
  if (base === 'require_approval' && !outcome.restriction && outcome.authorizedAllow && !neverWaived) {
    return result('allow', `Workspace policy “${outcome.authorizedAllow.policyName}” permits this action without approval.`, outcome.authorizedAllow)
  }
  if (base === 'require_approval' && outcome.unauthorizedAllow && !neverWaived) {
    return result(base, `${reason} Policy “${outcome.unauthorizedAllow.policyName}” can’t waive it: ${outcome.unauthorizedAllow.reason}.`)
  }
  return result(base, reason)
}

/** Minimum role that may ask for an action to run (it may still need approval). */
export const MIN_ROLE_TO_RUN_ACTIONS: OrganizationRole = 'operator'

/** Minimum role that may connect, disconnect and configure integrations. */
export const MIN_ROLE_TO_MANAGE_INTEGRATIONS: OrganizationRole = 'admin'

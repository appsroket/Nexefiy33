// The checks a workflow must pass before a version is activated, on the
// server, with everything read from the database:
//
//   1. the definition's shape (Zod) and every rule in domain/validation.ts in
//      activation mode (resources must exist, be active and be connected);
//   2. each tool action's decision now, from the integration executor's own
//      rules (connection, scopes, the action's setting, workspace policies):
//      an action that would be denied can't be activated;
//   3. hand-offs: when one employee's work leads to another employee's step,
//      workspace policy is asked about the pseudo-action "workflow.handoff"
//      for the receiving employee — "deny" blocks activation and
//      "require_approval" requires an approval step between the two;
//   4. the version records which employee version each step runs, so a run
//      always uses exactly what was approved.
//
// The result is the validation report stored with the version and the graph
// to activate (with employee versions stamped in).

import 'server-only'

import type { AdminClient } from '@/lib/supabase/admin'
import { evaluatePolicies, type StoredPolicy } from '@/modules/governance/domain/policy'
import { loadActivePolicies } from '@/modules/governance/server/state'
import { previewActionDecision } from '@/modules/integrations/server/executor'
import type { IntegrationRuntime } from '@/modules/integrations/server/runtime'

import { approvalBetween, handoffs, validateWorkflow, type ValidationIssue, type ValidationReport } from '../domain/validation'
import { checkSchedule } from '../domain/schedule'
import type { BuilderContext, WorkflowDefinition } from '../domain/types'

export const HANDOFF_POLICY_KEY = 'workflow.handoff'

export interface PermissionLine {
  nodeId: string
  label: string
  /** "action": the step runs this action itself; "employee": the employee may use it under its own grants. */
  kind: 'action' | 'employee'
  toolKey: string
  risk: string
  decision: 'allow' | 'require_approval' | 'deny' | 'employee_grant'
  reason: string
}

export interface ActivationCheck {
  report: ValidationReport & { permissions: PermissionLine[]; handoffs: { from: string; to: string; decision: string }[]; checkedAt: string }
  /** The graph to activate: employee steps carry the employee version they run. */
  graph: WorkflowDefinition
  schedule: { cron: string; timezone: string; next_run_at: string } | null
}

async function loadPolicies(admin: AdminClient, organizationId: string): Promise<StoredPolicy[]> {
  try {
    return await loadActivePolicies(admin, organizationId)
  } catch {
    throw new Error('Workspace policies couldn’t be loaded.')
  }
}

export async function checkForActivation(
  definition: WorkflowDefinition,
  context: BuilderContext,
  deps: { admin: AdminClient; integrations: IntegrationRuntime | null; organizationId: string; now: Date },
): Promise<ActivationCheck> {
  const base = validateWorkflow(definition, { mode: 'activation', context, now: deps.now })
  const errors: ValidationIssue[] = [...base.errors]
  const warnings: ValidationIssue[] = [...base.warnings]
  const permissions: PermissionLine[] = []

  // 2. Each tool action's decision under the executor's rules.
  for (const node of definition.nodes) {
    if (node.type !== 'tool_action' || !node.config.toolKey || !node.config.integrationId) continue
    const tool = context.tools.find((item) => item.key === node.config.toolKey)
    if (!tool) continue
    if (!deps.integrations) {
      errors.push({ severity: 'error', code: 'integrations_unavailable', message: `“${node.label}” needs integrations, which aren’t set up on this deployment.`, nodeId: node.id })
      continue
    }
    const preview = await previewActionDecision(deps.integrations, { organizationId: deps.organizationId, integrationId: node.config.integrationId, actionKey: node.config.toolKey })
    if (preview.status === 'refused') {
      errors.push({ severity: 'error', code: 'action_refused', message: `“${node.label}”: ${preview.error.message}`, nodeId: node.id })
      continue
    }
    const decision = node.config.requireApproval && preview.decision === 'allow' ? 'require_approval' : preview.decision
    if (decision === 'deny') {
      errors.push({ severity: 'error', code: 'action_denied', message: `“${node.label}” is blocked: ${preview.reason}`, nodeId: node.id })
    }
    permissions.push({
      nodeId: node.id,
      label: node.label,
      kind: 'action',
      toolKey: tool.key,
      risk: tool.risk,
      decision,
      reason: decision === 'require_approval' && preview.decision === 'allow' ? 'The step always asks for approval.' : preview.reason,
    })
  }

  // Employees act under their own grants; list them so the approver sees everything the workflow may do.
  for (const node of definition.nodes) {
    if (node.type !== 'employee_task') continue
    const employee = context.employees.find((item) => item.id === node.config.employeeId)
    for (const toolKey of employee?.toolKeys ?? []) {
      const tool = context.tools.find((item) => item.key === toolKey)
      permissions.push({ nodeId: node.id, label: node.label, kind: 'employee', toolKey, risk: tool?.risk ?? 'read', decision: 'employee_grant', reason: `${employee!.name}’s own grant (checked on every call).` })
    }
  }

  // 3. Hand-offs between employees.
  const policies = await loadPolicies(deps.admin, deps.organizationId)
  const handoffLines: ActivationCheck['report']['handoffs'] = []
  for (const { from, to } of handoffs(definition)) {
    const match = evaluatePolicies(policies, { toolKey: HANDOFF_POLICY_KEY, risk: 'write_internal', category: 'internal_update', actor: 'workflow', employeeId: to.config.employeeId })
    const decision = match?.effect ?? 'allow'
    handoffLines.push({ from: from.id, to: to.id, decision })
    if (decision === 'deny') {
      errors.push({ severity: 'error', code: 'handoff_denied', message: `Workspace policy “${match!.policyName}” doesn’t allow handing work from “${from.label}” to “${to.label}”.`, nodeId: to.id })
    } else if (decision === 'require_approval' && !approvalBetween(definition, from.id, to.id)) {
      errors.push({
        severity: 'error',
        code: 'handoff_needs_approval',
        message: `Workspace policy “${match!.policyName}” requires an approval step between “${from.label}” and “${to.label}”.`,
        nodeId: to.id,
      })
    }
  }

  // 4. Pin employee versions; schedule.
  const graph: WorkflowDefinition = {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.type !== 'employee_task') return node
      const employee = context.employees.find((item) => item.id === node.config.employeeId)
      return employee?.activeVersionId ? { ...node, config: { ...node.config, employeeVersionId: employee.activeVersionId } } : node
    }),
  }
  const trigger = definition.nodes.find((node) => node.type === 'trigger')
  let schedule: ActivationCheck['schedule'] = null
  if (trigger?.type === 'trigger' && trigger.config.kind === 'schedule') {
    const checked = checkSchedule(trigger.config.cron, trigger.config.timezone, deps.now)
    if (checked.ok) schedule = { cron: trigger.config.cron.trim(), timezone: trigger.config.timezone, next_run_at: checked.next.toISOString() }
  }

  return {
    report: { valid: errors.length === 0, errors, warnings, permissions, handoffs: handoffLines, checkedAt: deps.now.toISOString() },
    graph,
    schedule,
  }
}

// Reads for the governance pages, under the signed-in user's session (RLS:
// members read policies, versions and the emergency stop; only admins and
// owners read the audit log).

import 'server-only'

import { createUserClient } from '@/lib/supabase/server'
import { listMembers } from '@/modules/identity/server/queries'
import { listEmployeeTools } from '@/modules/employees/server/tools'

import { storedPolicyFromRow, type PolicyDocument } from '../domain/policy'

function fail(what: string, code: string | undefined): never {
  throw new Error(`Couldn’t load ${what} (${code ?? 'unknown'}).`)
}

export interface GovernanceState {
  emergencyStop: { at: string; reason: string; by: string | null } | null
  retention: { evidenceDays: number | null; eventDays: number | null; payloadDays: number | null; hold: boolean; lastPurgedAt: string | null }
}

export async function getGovernanceState(organizationId: string): Promise<GovernanceState> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('organization_governance')
    .select('emergency_stop_at, emergency_stop_reason, emergency_stop_by, evidence_retention_days, event_retention_days, payload_retention_days, retention_hold, last_purged_at')
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) fail('the governance settings', error.code)
  return {
    emergencyStop: data?.emergency_stop_at ? { at: data.emergency_stop_at, reason: data.emergency_stop_reason ?? '', by: data.emergency_stop_by } : null,
    retention: {
      evidenceDays: data?.evidence_retention_days ?? null,
      eventDays: data?.event_retention_days ?? null,
      payloadDays: data?.payload_retention_days ?? null,
      hold: data?.retention_hold ?? false,
      lastPurgedAt: data?.last_purged_at ?? null,
    },
  }
}

export interface PolicySummary {
  id: string
  name: string
  description: string | null
  enabled: boolean
  priority: number
  revision: number
  schemaVersion: number
  authorizedRole: 'owner' | 'admin' | null
  authorizedBy: string | null
  updatedAt: string
  document: PolicyDocument
}

export async function listPolicies(organizationId: string): Promise<PolicySummary[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('organization_policies')
    .select('id, name, description, enabled, priority, revision, policy_schema_version, authorized_role, authorized_by, updated_at, policy')
    .eq('organization_id', organizationId)
    .order('priority')
    .order('name')
  if (error) fail('the workspace policies', error.code)
  return data.map((row) => {
    const stored = storedPolicyFromRow(row)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      priority: row.priority,
      revision: row.revision,
      schemaVersion: row.policy_schema_version,
      authorizedRole: stored.authorizedRole,
      authorizedBy: row.authorized_by,
      updatedAt: row.updated_at,
      document: stored.document,
    }
  })
}

export interface PolicyVersion {
  id: string
  revision: number
  change: 'created' | 'updated' | 'deleted'
  name: string
  enabled: boolean
  priority: number
  schemaVersion: number
  authorizedRole: string | null
  changedBy: string | null
  createdAt: string
  document: PolicyDocument
}

export async function listPolicyVersions(organizationId: string, policyId: string): Promise<PolicyVersion[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('organization_policy_versions')
    .select('id, revision, change, name, enabled, priority, policy_schema_version, authorized_role, changed_by, created_at, policy')
    .eq('organization_id', organizationId)
    .eq('policy_id', policyId)
    .order('revision', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) fail('the policy history', error.code)
  return data.map((row) => ({
    id: row.id,
    revision: row.revision,
    change: row.change as PolicyVersion['change'],
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    schemaVersion: row.policy_schema_version,
    authorizedRole: row.authorized_role,
    changedBy: row.changed_by,
    createdAt: row.created_at,
    document: storedPolicyFromRow({ id: row.id, name: row.name, policy: row.policy }).document,
  }))
}

export interface PolicyEditorOptions {
  tools: { key: string; title: string; category: string }[]
  employees: { id: string; name: string }[]
  sources: { id: string; name: string }[]
}

export async function loadPolicyEditorOptions(organizationId: string): Promise<PolicyEditorOptions> {
  const supabase = await createUserClient()
  const [employees, sources] = await Promise.all([
    supabase.from('ai_employees').select('id, name').eq('organization_id', organizationId).neq('status', 'archived').order('name'),
    supabase.from('knowledge_sources').select('id, name').eq('organization_id', organizationId).order('name').limit(500),
  ])
  if (employees.error) fail('the employees', employees.error.code)
  if (sources.error) fail('the knowledge sources', sources.error.code)
  return {
    tools: listEmployeeTools().map((tool) => ({ key: tool.key, title: tool.title, category: tool.category })),
    employees: employees.data,
    sources: sources.data,
  }
}

/** Display names for user ids (members only; unknown ids stay unnamed). */
export async function memberNames(organizationId: string): Promise<Map<string, string>> {
  const members = await listMembers(organizationId)
  return new Map(members.map((member) => [member.userId, member.name ?? member.email ?? 'A member']))
}

// --- Audit log -------------------------------------------------------------------------

export const AUDIT_PAGE_SIZE = 50

export const AUDIT_GROUPS = {
  governance: { label: 'Governance', prefixes: ['governance.', 'organization_policies.', 'approval.'] },
  approvals: { label: 'Approvals', prefixes: ['approval_requests.', 'approval.'] },
  actions: { label: 'Actions', prefixes: ['action.'] },
  employees: { label: 'Employees', prefixes: ['employee.', 'ai_employees.', 'employee_versions.', 'employee_tool_permissions.'] },
  tasks: { label: 'Tasks', prefixes: ['task.'] },
  workflows: { label: 'Workflows', prefixes: ['workflow', 'workflow_run.'] },
  integrations: { label: 'Integrations', prefixes: ['integration', 'integrations.', 'integration_actions.', 'integration_secrets.'] },
  members: { label: 'Members', prefixes: ['organization_members.', 'organization_invitations.', 'organizations.'] },
} as const
export type AuditGroup = keyof typeof AUDIT_GROUPS

export interface AuditEntry {
  id: number
  occurredAt: string
  actorType: string
  actorUserId: string | null
  actorEmployeeId: string | null
  action: string
  targetTable: string | null
  targetId: string | null
  metadata: Record<string, unknown>
}

export async function listAuditLog(
  organizationId: string,
  filters: { group?: AuditGroup; actorType?: string; before?: number },
): Promise<{ entries: AuditEntry[]; next: number | null }> {
  const supabase = await createUserClient()
  let query = supabase
    .from('audit_logs')
    .select('id, occurred_at, actor_type, actor_user_id, actor_employee_id, action, target_table, target_id, metadata')
    .eq('organization_id', organizationId)
    .order('id', { ascending: false })
    .limit(AUDIT_PAGE_SIZE + 1)
  if (filters.group) query = query.or(AUDIT_GROUPS[filters.group].prefixes.map((prefix) => `action.like.${prefix}*`).join(','))
  if (filters.actorType) query = query.eq('actor_type', filters.actorType)
  if (filters.before) query = query.lt('id', filters.before)
  const { data, error } = await query
  if (error) fail('the audit log', error.code)
  const entries = data.slice(0, AUDIT_PAGE_SIZE).map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    actorEmployeeId: row.actor_employee_id,
    action: row.action,
    targetTable: row.target_table,
    targetId: row.target_id,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }))
  return { entries, next: data.length > AUDIT_PAGE_SIZE ? entries.at(-1)!.id : null }
}

export interface EmployeeGrant {
  toolKey: string
  title: string
  integrationId: string | null
  decision: string
  category: string
}

/** What an employee may use right now: the grants written when it was activated (and not revoked since). */
export async function listEmployeeGrants(organizationId: string, employeeId: string): Promise<EmployeeGrant[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('employee_tool_permissions')
    .select('tool_key, integration_id, decision')
    .eq('organization_id', organizationId)
    .eq('employee_id', employeeId)
    .order('tool_key')
  if (error) fail('the employee’s permissions', error.code)
  const tools = listEmployeeTools()
  return data.map((row) => {
    const tool = tools.find((candidate) => candidate.key === row.tool_key)
    return { toolKey: row.tool_key, title: tool?.title ?? row.tool_key, integrationId: row.integration_id, decision: row.decision, category: tool?.category ?? 'read' }
  })
}

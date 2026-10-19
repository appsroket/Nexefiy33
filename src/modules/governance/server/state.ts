// Reads the workspace's governance state for server code that acts: the
// enabled policies (in priority order) and whether the emergency stop is on.
// Service-role reads, always scoped by organization.

import 'server-only'

import type { AdminClient } from '@/lib/supabase/admin'

import { combineControls, storedPolicyFromRow, type GovernanceControls, type StoredPolicy } from '../domain/policy'

export class GovernanceUnavailableError extends Error {
  constructor(what: string) {
    super(`${what} couldn’t be loaded.`)
  }
}

export async function loadActivePolicies(admin: AdminClient, organizationId: string): Promise<StoredPolicy[]> {
  const { data, error } = await admin
    .from('organization_policies')
    .select('id, name, revision, policy_schema_version, authorized_role, policy')
    .eq('organization_id', organizationId)
    .eq('enabled', true)
    .order('priority')
  if (error) throw new GovernanceUnavailableError('Workspace policies')
  return (data ?? []).map(storedPolicyFromRow)
}

export interface EmergencyStop {
  at: string
  reason: string
}

export async function loadEmergencyStop(admin: AdminClient, organizationId: string): Promise<EmergencyStop | null> {
  const { data, error } = await admin
    .from('organization_governance')
    .select('emergency_stop_at, emergency_stop_reason')
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) throw new GovernanceUnavailableError('The emergency stop setting')
  return data?.emergency_stop_at ? { at: data.emergency_stop_at, reason: data.emergency_stop_reason ?? '' } : null
}

export async function loadControls(admin: AdminClient, organizationId: string): Promise<{ policies: StoredPolicy[]; controls: GovernanceControls }> {
  const policies = await loadActivePolicies(admin, organizationId)
  return { policies, controls: combineControls(policies) }
}

/** Model spend this month for the workspace (all employees). */
export async function organizationMonthlySpendMicros(admin: AdminClient, organizationId: string, now: Date): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const { data, error } = await admin
    .from('usage_records')
    .select('cost_micros')
    .eq('organization_id', organizationId)
    .eq('metric', 'model_cost')
    .gte('occurred_at', start)
  if (error) throw new GovernanceUnavailableError('The workspace’s spending')
  return (data ?? []).reduce((sum, row) => sum + (row.cost_micros ?? 0), 0)
}

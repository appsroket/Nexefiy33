// Evidence retention. The purge itself is one SQL function (service role
// only) so it applies the same bounds, hold and audit entry however it runs.

import 'server-only'

import { getAdminClient, type AdminClient } from '@/lib/supabase/admin'

export interface PurgeCounts {
  evidence: number
  events: number
  payloads: number
  approvals: number
}

/** Purges data past each workspace's retention; returns counts per workspace. */
export async function purgeExpiredTaskData(admin: AdminClient = getAdminClient(), limit = 5000): Promise<Record<string, PurgeCounts>> {
  const { data, error } = await admin.rpc('purge_expired_task_data', { p_limit: limit })
  if (error) throw new Error(`Retention purge failed (${error.code ?? 'unknown'}).`)
  return (data ?? {}) as unknown as Record<string, PurgeCounts>
}

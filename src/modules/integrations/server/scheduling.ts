// Runs approved actions soon after the approval, without making the approver
// wait. The queue is in Postgres (tool_executions in "approved" state), so
// this is only a nudge: if it doesn't run, the cron route
// (/api/cron/integrations) claims the execution later. Durable execution
// replaces the nudge in a later phase without changing the queue.

import 'server-only'

import { after } from 'next/server'

import { isFeatureConfigured } from '@/lib/env/server'
import { redact } from '@/lib/logging/redact'
import { getAdminClient } from '@/lib/supabase/admin'

import { processApprovedExecutions } from './executor'
import { getIntegrationRuntime } from './runtime'

export function canRunIntegrations(): boolean {
  return isFeatureConfigured('supabaseAdmin') && isFeatureConfigured('credentialEncryption')
}

export function scheduleApprovedExecutions(): void {
  if (!canRunIntegrations()) return
  after(async () => {
    try {
      await processApprovedExecutions(getIntegrationRuntime(), 5)
    } catch (error) {
      console.error('[integrations] running approved actions failed; they stay queued', redact(error))
    }
  })
}

/** Closes the task that waited on a rejected approval (the execution itself is rejected by decide_approval). */
export async function closeRejectedTask(organizationId: string, taskId: string): Promise<void> {
  if (!isFeatureConfigured('supabaseAdmin')) return
  const { error } = await getAdminClient()
    .from('tasks')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('organization_id', organizationId)
    .eq('status', 'waiting_approval')
  if (error) console.error('[integrations] closing a rejected task failed', redact({ code: error.code }))
}

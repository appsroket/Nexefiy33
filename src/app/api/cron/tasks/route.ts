// Task housekeeping, called by Vercel Cron with
// "Authorization: Bearer <CRON_SECRET>": expires overdue approvals (which
// cancels their actions and lets waiting employee tasks continue), runs
// approved actions, and runs queued employee tasks — including tasks whose
// server stopped mid-step (expired leases), which continue from their last
// checkpoint. Needs CRON_SECRET, the Supabase secret key and an AI model;
// integration actions also need the credential encryption keys.

import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { isFeatureConfigured, requireFeature } from '@/lib/env/server'
import { redact } from '@/lib/logging/redact'
import { getAdminClient } from '@/lib/supabase/admin'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import { getIntegrationRuntime } from '@/modules/integrations/server/runtime'
import { canRunIntegrations } from '@/modules/integrations/server/scheduling'
import { processEmployeeTasks } from '@/modules/tasks/server/runner'
import { canRunTasks, getTaskRuntimeDeps } from '@/modules/tasks/server/scheduling'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function authorized(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(header ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function GET(request: Request) {
  if (!isFeatureConfigured('cronAuth') || !isFeatureConfigured('supabaseAdmin')) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (!authorized(request.headers.get('authorization'), requireFeature('cronAuth').secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { data: expired, error } = await getAdminClient().rpc('expire_overdue_approvals', { p_limit: 100 })
    if (error) throw new Error(`expiring approvals failed (${error.code})`)

    const actions = canRunIntegrations() ? await processApprovedExecutions(getIntegrationRuntime(), 10) : null
    const tasks = canRunTasks() ? await processEmployeeTasks(getTaskRuntimeDeps(), 3) : null
    const outcomes = (tasks?.results ?? []).reduce<Record<string, number>>((totals, result) => {
      totals[result.status] = (totals[result.status] ?? 0) + 1
      return totals
    }, {})
    return NextResponse.json({
      approvalsExpired: expired ?? 0,
      actions: actions ? { claimed: actions.claimed } : 'not_configured',
      tasks: tasks ? { claimed: tasks.claimed, ...outcomes } : 'not_configured',
    })
  } catch (error) {
    console.error('[tasks] cron run failed', redact(error))
    return NextResponse.json({ error: 'Run failed' }, { status: 500 })
  }
}

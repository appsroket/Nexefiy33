// Integration housekeeping, called by Vercel Cron with
// "Authorization: Bearer <CRON_SECRET>": runs approved actions whose
// after-approval nudge didn't run, recovers actions whose server stopped
// mid-run (expired leases), checks the health of connections not checked in
// the last six hours (which also renews expiring tokens), and deletes old
// OAuth states. Needs CRON_SECRET, the Supabase secret key and the
// credential encryption keys; refuses everything else.

import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { isFeatureConfigured, requireFeature } from '@/lib/env/server'
import { redact } from '@/lib/logging/redact'
import { checkHealth, connectionsDueForHealthCheck } from '@/modules/integrations/server/connections'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import { purgeOAuthStates } from '@/modules/integrations/server/oauth'
import { getIntegrationRuntime } from '@/modules/integrations/server/runtime'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const HEALTH_INTERVAL_MS = 6 * 60 * 60_000

function authorized(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(header ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function GET(request: Request) {
  if (!isFeatureConfigured('cronAuth') || !isFeatureConfigured('supabaseAdmin') || !isFeatureConfigured('credentialEncryption')) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (!authorized(request.headers.get('authorization'), requireFeature('cronAuth').secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const runtime = getIntegrationRuntime()
  try {
    const executions = await processApprovedExecutions(runtime, 10)
    const outcomes = executions.results.reduce<Record<string, number>>((totals, result) => {
      totals[result.status] = (totals[result.status] ?? 0) + 1
      return totals
    }, {})

    const health: Record<string, number> = {}
    for (const connection of await connectionsDueForHealthCheck(runtime, HEALTH_INTERVAL_MS, 20)) {
      try {
        const report = await checkHealth(runtime, connection.organization_id, connection.id)
        health[report.status] = (health[report.status] ?? 0) + 1
      } catch (error) {
        console.error('[integrations] scheduled health check failed', redact(error))
        health.error = (health.error ?? 0) + 1
      }
    }

    await purgeOAuthStates(runtime)
    return NextResponse.json({ executions: { claimed: executions.claimed, ...outcomes }, health })
  } catch (error) {
    console.error('[integrations] cron run failed', redact(error))
    return NextResponse.json({ error: 'Run failed' }, { status: 500 })
  }
}

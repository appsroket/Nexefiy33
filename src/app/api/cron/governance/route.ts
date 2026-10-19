// Governance housekeeping, called by Vercel Cron with
// "Authorization: Bearer <CRON_SECRET>": applies each workspace's evidence
// retention (purge_expired_task_data deletes old evidence and execution
// events and clears old action payloads; held workspaces are skipped; the
// audit log is never touched here). Needs CRON_SECRET and the Supabase secret
// key; refuses everything else. Safe to re-run.

import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { isFeatureConfigured, requireFeature } from '@/lib/env/server'
import { redact } from '@/lib/logging/redact'
import { purgeExpiredTaskData } from '@/modules/governance/server/retention'

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
    return NextResponse.json({ retention: await purgeExpiredTaskData() })
  } catch (error) {
    console.error('[governance] retention run failed', redact(error))
    return NextResponse.json({ error: 'Run failed' }, { status: 500 })
  }
}

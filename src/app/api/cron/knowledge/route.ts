// Processes queued knowledge sources: new uploads whose after-response nudge
// didn't run, retries whose time has come, and sources whose worker died
// (expired leases). Called by Vercel Cron with "Authorization: Bearer
// <CRON_SECRET>"; refuses everything else. Needs CRON_SECRET and the Supabase
// secret key.

import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { isFeatureConfigured, requireFeature } from '@/lib/env/server'
import { redact } from '@/lib/logging/redact'
import { getAdminClient } from '@/lib/supabase/admin'
import { getEmbedder } from '@/modules/knowledge/server/embeddings'
import { processKnowledgeQueue } from '@/modules/knowledge/server/processor'

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
    const summary = await processKnowledgeQueue({ admin: getAdminClient(), embedder: getEmbedder(), limit: 10 })
    const counts = summary.outcomes.reduce<Record<string, number>>((totals, outcome) => {
      totals[outcome.result] = (totals[outcome.result] ?? 0) + 1
      return totals
    }, {})
    return NextResponse.json({ claimed: summary.claimed, ...counts })
  } catch (error) {
    console.error('[knowledge] cron processing failed', redact(error))
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}

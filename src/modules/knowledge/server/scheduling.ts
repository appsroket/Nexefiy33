// Starts knowledge processing after a change, without making the person wait.
//
// The queue lives in Postgres, so this is only a nudge: `after()` processes a
// few due sources once the response has been sent. If it doesn't run (no
// privileged key configured, the instance is recycled, a timeout), nothing is
// lost — the sources stay queued and the cron route (/api/cron/knowledge)
// or the next nudge picks them up. Durable execution replaces the nudge in a
// later phase without changing the queue.

import 'server-only'

import { after } from 'next/server'

import { isFeatureConfigured } from '@/lib/env/server'
import { redact } from '@/lib/logging/redact'
import { getAdminClient } from '@/lib/supabase/admin'

import { getEmbedder } from './embeddings'
import { processKnowledgeQueue } from './processor'

/** True when this deployment can process documents (it needs the Supabase secret key). */
export function canProcessKnowledge(): boolean {
  return isFeatureConfigured('supabaseAdmin')
}

export function scheduleKnowledgeProcessing(organizationId: string): void {
  if (!canProcessKnowledge()) return
  after(async () => {
    try {
      await processKnowledgeQueue({ admin: getAdminClient(), embedder: getEmbedder(), organizationId, limit: 5 })
    } catch (error) {
      console.error('[knowledge] background processing failed; sources stay queued', redact(error))
    }
  })
}

// Runs queued employee tasks soon after something queues them (an
// assignment, an approval decision, a reply), without making the person
// wait. The queue is in Postgres (tasks in "queued" state), so this is only a
// nudge: if it doesn't run, the cron route (/api/cron/tasks) claims the task
// later. A durable engine replaces the nudge in a later phase without
// changing the queue.

import 'server-only'

import { after } from 'next/server'

import { isFeatureConfigured } from '@/lib/env/server'
import { redact } from '@/lib/logging/redact'
import { getAdminClient } from '@/lib/supabase/admin'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import { getIntegrationRuntime } from '@/modules/integrations/server/runtime'
import { canRunIntegrations } from '@/modules/integrations/server/scheduling'
import { getEmbedder } from '@/modules/knowledge/server/embeddings'
import { getModelGateway, isModelConfigured } from '@/modules/models/server/provider'

import { processEmployeeTasks, type TaskRuntimeDeps } from './runner'

/** Tasks need the Supabase secret key (the runtime records state) and a model. */
export function canRunTasks(): boolean {
  return isFeatureConfigured('supabaseAdmin') && isModelConfigured()
}

export function getTaskRuntimeDeps(): TaskRuntimeDeps {
  return {
    admin: getAdminClient(),
    gateway: getModelGateway(),
    integrations: canRunIntegrations() ? getIntegrationRuntime() : null,
    embedder: getEmbedder(),
  }
}

/**
 * After the response: run approved actions first (when an approval was just
 * given, its task resumes only once the action has a result), then queued
 * tasks.
 */
export function scheduleTaskProcessing(options: { approvedActions?: boolean } = {}): void {
  const runActions = options.approvedActions && canRunIntegrations()
  const runTasks = canRunTasks()
  if (!runActions && !runTasks) return
  after(async () => {
    try {
      if (runActions) await processApprovedExecutions(getIntegrationRuntime(), 5)
      if (runTasks) await processEmployeeTasks(getTaskRuntimeDeps(), 2)
    } catch (error) {
      console.error('[tasks] processing after the response failed; the queue keeps the work', redact(error))
    }
  })
}

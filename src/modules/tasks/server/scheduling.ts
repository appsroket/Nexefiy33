// Starts queued work soon after something queues it (an assignment, an
// approval decision, a reply, a resume, a retry), without making the person
// wait. The queue is in Postgres, so this is only a nudge.
//
// With the execution engine configured (Trigger.dev, ADR-026), the request
// only enqueues a dispatch; tasks run in engine jobs, never in the request.
// Without it (development, or before the engine is set up), one bounded
// segment runs after the response and /api/cron/tasks picks up the rest;
// every step is checkpointed, so a stopped request loses nothing.

import 'server-only'

import { after } from 'next/server'

import { redact } from '@/lib/logging/redact'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import { canRunIntegrations, getIntegrationRuntime } from '@/modules/integrations/server/runtime'

import { enqueueDispatch, isEngineConfigured } from './engine'
import { processEmployeeTasks } from './runner'
import { canRunTasks, getTaskRuntimeDeps } from './runtime-deps'

export { canRunTasks, getTaskRuntimeDeps }

/**
 * After the response: with the engine, enqueue a dispatch. Without it, run
 * approved actions first (a task resumes only once its action has a result),
 * then queued tasks.
 */
export function scheduleTaskProcessing(options: { approvedActions?: boolean; reason?: string } = {}): void {
  if (isEngineConfigured()) {
    after(async () => {
      try {
        await enqueueDispatch(options.reason ?? (options.approvedActions ? 'approval' : 'request'))
      } catch (error) {
        console.error('[tasks] enqueueing a dispatch failed; the scheduled sweep picks the work up', redact(error))
      }
    })
    return
  }
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

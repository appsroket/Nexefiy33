// Advances workflow runs soon after something changes (a run started, an
// approval decided), without making the person wait. Run state is in
// Postgres, so this is only a nudge.
//
// With the execution engine configured, the request only enqueues a
// dispatch; runs advance in engine jobs, never in the request. Without it,
// one bounded segment runs after the response — advance, run the employee
// tasks it queued, advance again — and the cron route picks up the rest.

import 'server-only'

import { after } from 'next/server'

import { redact } from '@/lib/logging/redact'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import { enqueueDispatch, isEngineConfigured } from '@/modules/tasks/server/engine'
import { processEmployeeTasks } from '@/modules/tasks/server/runner'
import { canRunTasks, getTaskRuntimeDeps } from '@/modules/tasks/server/runtime-deps'

import { processWorkflowRuns } from './orchestrator'
import { canRunWorkflows, getWorkflowRuntimeDeps } from './runtime-deps'

/** Rounds of advance → tasks in one after-response segment (without the engine). */
const INLINE_ROUNDS = 2

export function scheduleWorkflowProcessing(options: { reason: string; runId?: string; approvedActions?: boolean }): void {
  if (isEngineConfigured()) {
    after(async () => {
      try {
        await enqueueDispatch(options.reason)
      } catch (error) {
        console.error('[workflows] enqueueing a dispatch failed; the scheduled sweep picks the run up', redact(error))
      }
    })
    return
  }
  if (!canRunWorkflows()) return
  after(async () => {
    try {
      const deps = getWorkflowRuntimeDeps()
      if (options.approvedActions && deps.integrations) await processApprovedExecutions(deps.integrations, 5)
      for (let round = 0; round < INLINE_ROUNDS; round++) {
        const { results } = await processWorkflowRuns(deps, 3, options.runId)
        if (!results.some((result) => result.queuedTasks > 0) || !canRunTasks()) break
        await processEmployeeTasks(getTaskRuntimeDeps(), 2)
      }
    } catch (error) {
      console.error('[workflows] advancing after the response failed; the run keeps its state', redact(error))
    }
  })
}

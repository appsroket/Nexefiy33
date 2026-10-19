// Trigger.dev job for workflow runs (ADR-026, ADR-027). A thin wrapper: the
// orchestrator (src/modules/workflows/server/orchestrator.ts) claims the run
// under a lease, advances it as far as it can go now, records its progress in
// Postgres and returns. Nothing waits inside the job: approvals, employee
// tasks and delays are states of the run's steps, and the next dispatch
// advances the run again when one of them changes.
//
//   workflow-runs.advance   claims and advances one run
//
// Engine-level retries are off: a job that fails leaves its lease to expire
// and the next dispatch recovers the run from what was recorded.

import { logger, queue, task } from '@trigger.dev/sdk'

import { ENGINE_JOBS, enqueueDispatch, type AdvanceRunPayload } from '@/modules/tasks/server/engine'
import { processWorkflowRuns } from '@/modules/workflows/server/orchestrator'
import { canRunWorkflows, getWorkflowRuntimeDeps } from '@/modules/workflows/server/runtime-deps'

const runQueue = queue({ name: 'workflow-runs', concurrencyLimit: 10 })

export const advanceWorkflowRun = task({
  id: ENGINE_JOBS.advanceRun,
  queue: runQueue,
  // One advance plus tool actions with their retries; the lease (330 s) is renewed after each step.
  maxDuration: 600,
  retry: { maxAttempts: 1 },
  run: async (payload: AdvanceRunPayload) => {
    if (!canRunWorkflows()) return { skipped: 'not_configured' as const }
    const { claimed, results } = await processWorkflowRuns(getWorkflowRuntimeDeps(), 1, payload.runId)
    if (!claimed) {
      logger.info('Run not claimable; nothing to do', { runId: payload.runId })
      return { claimed: 0 }
    }
    // New employee tasks wait in the queue; a dispatch starts them now rather than at the next sweep.
    if (results.some((result) => result.queuedTasks > 0)) await enqueueDispatch('workflow_advanced')
    return { claimed, results: results.map((result) => ({ status: result.status, queuedTasks: result.queuedTasks })) }
  },
})

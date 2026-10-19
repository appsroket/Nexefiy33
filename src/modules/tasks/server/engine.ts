// The execution engine (Trigger.dev, ADR-026) from the application's side:
// enqueueing a dispatch and starting one job per due task. The engine only
// executes; task state lives in Postgres and every job re-checks it (ADR-005).
// The job definitions are in trigger/employee-tasks.ts.

import 'server-only'

import { configure, tasks } from '@trigger.dev/sdk'

import { isFeatureConfigured, requireFeature } from '@/lib/env/server'

import type { DueTask } from './dispatch'

export const ENGINE_JOBS = {
  dispatch: 'employee-tasks.dispatch',
  run: 'employee-tasks.run',
} as const

export interface DispatchPayload {
  reason: string
}

export interface RunTaskPayload {
  taskId: string
  organizationId: string
}

/** How long a job key blocks a duplicate job for the same task state. */
const JOB_KEY_TTL = '10m'

export function isEngineConfigured(): boolean {
  return isFeatureConfigured('backgroundJobs')
}

let configured = false

/**
 * Points the SDK at this environment's Trigger.dev project. Inside an engine
 * job the SDK is already configured by the run, so this is a no-op there when
 * the key isn't set.
 */
function ensureConfigured(): void {
  if (configured || !isEngineConfigured()) return
  configure({ secretKey: requireFeature('backgroundJobs').secretKey })
  configured = true
}

export async function enqueueDispatch(reason: string): Promise<void> {
  ensureConfigured()
  await tasks.trigger(ENGINE_JOBS.dispatch, { reason } satisfies DispatchPayload, { tags: [`reason:${reason.slice(0, 40)}`] })
}

/**
 * One job per due task. The key includes the task's version (updated_at), so
 * the same queued state never gets two jobs, while a task that changed (was
 * re-queued after an approval, recovered after a lost lease) gets a new one.
 * Jobs of one organization share a concurrency key, so one busy workspace
 * cannot take every worker.
 */
export async function startTaskJobs(due: readonly DueTask[]): Promise<void> {
  if (!due.length) return
  ensureConfigured()
  await tasks.batchTrigger(
    ENGINE_JOBS.run,
    due.map((task) => ({
      payload: { taskId: task.taskId, organizationId: task.organizationId } satisfies RunTaskPayload,
      options: {
        idempotencyKey: `employee-task:${task.taskId}:${task.version}`,
        idempotencyKeyTTL: JOB_KEY_TTL,
        concurrencyKey: task.organizationId,
        tags: [`task:${task.taskId}`, `org:${task.organizationId}`],
      },
    })),
  )
}

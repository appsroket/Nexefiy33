// Trigger.dev jobs for employee tasks (ADR-026). Thin wrappers: the work and
// every state change live in src/modules/tasks (Postgres is the record), so
// the engine is replaceable and a job that runs late, twice or never cannot
// corrupt a task — the next dispatch recovers it from its checkpoint.
//
//   employee-tasks.sweep     every minute: dispatch (sweep, approved actions,
//                            start due tasks)
//   employee-tasks.dispatch  the same, on demand (an assignment, a decision,
//                            a reply, a resume, a retry)
//   employee-tasks.run       claims and runs one task until it finishes,
//                            waits (approval, reply) or pauses
//
// Engine-level retries are off for task jobs: retries are attempts in
// Postgres, with failure classes and backoff (src/modules/tasks/domain).

import { logger, queue, schedules, task } from '@trigger.dev/sdk'

import { dispatchDueTasks } from '@/modules/tasks/server/dispatch'
import { ENGINE_JOBS, enqueueDispatch, startTaskJobs, type DispatchPayload, type RunTaskPayload } from '@/modules/tasks/server/engine'
import { processEmployeeTasks } from '@/modules/tasks/server/runner'
import { canRunTasks, getTaskRuntimeDeps } from '@/modules/tasks/server/runtime-deps'

const dispatchQueue = queue({ name: 'employee-tasks-dispatch', concurrencyLimit: 1 })
const taskQueue = queue({ name: 'employee-tasks', concurrencyLimit: 10 })

async function dispatch(reason: string) {
  if (!canRunTasks()) {
    logger.warn('Tasks are not configured in this environment (Supabase secret key and a model are required).')
    return { skipped: 'not_configured' as const }
  }
  const deps = getTaskRuntimeDeps()
  const result = await dispatchDueTasks({ admin: deps.admin, integrations: deps.integrations, start: startTaskJobs })
  logger.info('Dispatched employee tasks', { reason, ...result })
  return result
}

export const dispatchEmployeeTasks = task({
  id: ENGINE_JOBS.dispatch,
  queue: dispatchQueue,
  maxDuration: 120,
  retry: { maxAttempts: 3 },
  run: async (payload: DispatchPayload) => dispatch(payload.reason),
})

export const sweepEmployeeTasks = schedules.task({
  id: 'employee-tasks.sweep',
  cron: '* * * * *',
  queue: dispatchQueue,
  maxDuration: 120,
  run: async () => dispatch('schedule'),
})

export const runEmployeeTask = task({
  id: ENGINE_JOBS.run,
  queue: taskQueue,
  // Longer than one checkpointed step; the lease (330 s) is renewed after each.
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  run: async (payload: RunTaskPayload) => {
    if (!canRunTasks()) return { skipped: 'not_configured' as const }
    const { claimed, results } = await processEmployeeTasks(getTaskRuntimeDeps(), 1, payload.taskId)
    if (!claimed) {
      // Someone else holds it, or it is no longer due (cancelled, paused, waiting).
      logger.info('Task not claimable; nothing to do', { taskId: payload.taskId })
      return { claimed: 0 }
    }
    // A finished task may release tasks that depend on it.
    if (results.some((result) => result.status === 'succeeded' || result.status === 'failed' || result.status === 'cancelled')) {
      await enqueueDispatch('task_finished')
    }
    return { claimed, results: results.map((result) => ({ status: result.status, failure: result.failure?.code ?? null })) }
  },
})

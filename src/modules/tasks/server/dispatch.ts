// The dispatcher: the one place that decides what runs next. The execution
// engine calls it on a schedule and whenever something queues work; without
// an engine, the cron route and the after-response nudge call the same code.
//
//   1. sweep: expire overdue approvals (their actions are withdrawn and
//      waiting tasks continue) and time out tasks past their deadline
//   2. run approved actions (an approved action runs before its task resumes)
//   3. find due tasks (queued, or running with an expired lease) and hand each
//      to `start`, which runs it as its own job
//
// Nothing is claimed here: the job claims its task (claim_employee_tasks with
// p_task_id), so a job that starts late or twice can never run a task that
// someone else holds. Listing due tasks and the sweep cross organizations by
// design, like the claim functions; every row carries its organization and
// every later query is scoped to it.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import type { AdminClient } from '@/lib/supabase/admin'
import { processApprovedExecutions } from '@/modules/integrations/server/executor'
import type { IntegrationRuntime } from '@/modules/integrations/server/runtime'

export interface DueTask {
  taskId: string
  organizationId: string
  /** Changes whenever the task changes, so a job key per state is unique. */
  version: string
}

export interface DispatchResult {
  approvalsExpired: number
  tasksTimedOut: number
  actionsRun: number | 'not_configured'
  started: number
}

export async function sweepTaskQueue(admin: AdminClient): Promise<{ approvalsExpired: number; tasksTimedOut: number }> {
  const [expired, timedOut] = await Promise.all([
    admin.rpc('expire_overdue_approvals', { p_limit: 200 }),
    admin.rpc('time_out_overdue_tasks', { p_limit: 200 }),
  ])
  if (expired.error || timedOut.error) {
    console.error('[tasks] sweeping the queue failed', redact({ approvals: expired.error?.code, tasks: timedOut.error?.code }))
    throw new Error('The task queue couldn’t be swept.')
  }
  return { approvalsExpired: expired.data ?? 0, tasksTimedOut: timedOut.data ?? 0 }
}

export async function listDueTasks(admin: AdminClient, now: Date, limit = 50): Promise<DueTask[]> {
  const at = now.toISOString()
  const { data, error } = await admin
    .from('tasks')
    .select('id, organization_id, updated_at')
    .not('employee_id', 'is', null)
    .or(`and(status.eq.queued,or(scheduled_at.is.null,scheduled_at.lte.${at})),and(status.eq.running,lease_expires_at.lt.${at})`)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) {
    console.error('[tasks] listing due tasks failed', redact({ code: error.code }))
    throw new Error('Due tasks couldn’t be listed.')
  }
  return (data ?? []).map((row) => ({ taskId: row.id, organizationId: row.organization_id, version: row.updated_at }))
}

export async function dispatchDueTasks(deps: {
  admin: AdminClient
  integrations: IntegrationRuntime | null
  start: (tasks: DueTask[]) => Promise<void>
  now?: () => Date
}): Promise<DispatchResult> {
  const now = deps.now ?? (() => new Date())
  const swept = await sweepTaskQueue(deps.admin)
  let actionsRun: DispatchResult['actionsRun'] = 'not_configured'
  if (deps.integrations) {
    try {
      actionsRun = (await processApprovedExecutions(deps.integrations, 10)).claimed
    } catch (error) {
      // Approved actions stay queued; their tasks wait until they have a result.
      console.error('[tasks] running approved actions failed', redact(error))
      actionsRun = 0
    }
  }
  const due = await listDueTasks(deps.admin, now())
  if (due.length) await deps.start(due)
  return { ...swept, actionsRun, started: due.length }
}

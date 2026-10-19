// The workflow side of the dispatcher (src/modules/tasks/server/dispatch.ts):
// starting runs whose schedule is due, and finding runs that need advancing
// (something they wait on changed, a delay or retry is due, the deadline
// passed, or their orchestrator stopped). Like the task queue, listing
// crosses organizations by design; every row carries its organization and
// every later query is scoped to it. Nothing is claimed here: each advance
// claims its run.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import type { AdminClient } from '@/lib/supabase/admin'

import { nextRun, parseCron } from '../domain/schedule'

export interface DueRun {
  runId: string
  organizationId: string
  /** Changes whenever the run changes, so a job key per state is unique. */
  version: string
}

/** Starts the runs of due schedules and computes missing next-run times. Returns how many runs started. */
export async function startDueSchedules(admin: AdminClient, now: Date, limit = 50): Promise<number> {
  const at = now.toISOString()
  const { data, error } = await admin
    .from('workflow_triggers')
    .select('id, organization_id, cron_expression, timezone, next_run_at')
    .eq('trigger_type', 'schedule')
    .eq('enabled', true)
    .or(`next_run_at.is.null,next_run_at.lte.${at}`)
    .limit(limit)
  if (error) {
    console.error('[workflows] listing due schedules failed', redact({ code: error.code }))
    throw new Error('Due schedules couldn’t be listed.')
  }
  let started = 0
  for (const trigger of data ?? []) {
    const schedule = parseCron(trigger.cron_expression ?? '')
    const next = typeof schedule === 'string' ? null : nextRun(schedule, trigger.timezone ?? 'UTC', now)
    if (!next) {
      // An expression that never runs again: switch the schedule off rather than retrying every minute.
      await admin.from('workflow_triggers').update({ enabled: false }).eq('id', trigger.id).eq('organization_id', trigger.organization_id)
      continue
    }
    if (!trigger.next_run_at) {
      await admin.from('workflow_triggers').update({ next_run_at: next.toISOString() }).eq('id', trigger.id).eq('organization_id', trigger.organization_id).is('next_run_at', null)
      continue
    }
    const { data: runId, error: startError } = await admin.rpc('start_scheduled_workflow_run', {
      p_trigger_id: trigger.id,
      p_fire_at: trigger.next_run_at,
      p_next_run_at: next.toISOString(),
    })
    if (startError) console.error('[workflows] starting a scheduled run failed', redact({ code: startError.code }))
    else if (runId) started++
  }
  return started
}

export async function listDueRuns(admin: AdminClient, now: Date, limit = 50): Promise<DueRun[]> {
  const at = now.toISOString()
  const { data, error } = await admin
    .from('workflow_runs')
    .select('id, organization_id, updated_at')
    .in('status', ['queued', 'running', 'waiting'])
    .or(`and(lease_expires_at.is.null,or(advance_requested_at.not.is.null,wake_at.lte.${at},deadline_at.lte.${at})),lease_expires_at.lt.${at}`)
    .order('queued_at', { ascending: true })
    .limit(limit)
  if (error) {
    console.error('[workflows] listing due runs failed', redact({ code: error.code }))
    throw new Error('Due workflow runs couldn’t be listed.')
  }
  return (data ?? []).map((row) => ({ runId: row.id, organizationId: row.organization_id, version: row.updated_at }))
}

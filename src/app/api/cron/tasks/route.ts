// Task housekeeping, called by Vercel Cron with
// "Authorization: Bearer <CRON_SECRET>".
//
// With the execution engine (Trigger.dev) configured, this only enqueues a
// dispatch; the engine's own one-minute schedule does the same, so the cron
// job is optional there. Without the engine, it runs the dispatcher inline:
// expires overdue approvals, times out tasks past their deadline, runs
// approved actions, and runs due employee tasks (including tasks whose server
// stopped mid-step, which continue from their last checkpoint). Needs
// CRON_SECRET, the Supabase secret key and an AI model; integration actions
// also need the credential encryption keys.

import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { isFeatureConfigured, requireFeature } from '@/lib/env/server'
import { redact } from '@/lib/logging/redact'
import { getAdminClient } from '@/lib/supabase/admin'
import { canRunIntegrations, getIntegrationRuntime } from '@/modules/integrations/server/runtime'
import { dispatchDueTasks, sweepTaskQueue } from '@/modules/tasks/server/dispatch'
import { enqueueDispatch, isEngineConfigured } from '@/modules/tasks/server/engine'
import { processEmployeeTasks } from '@/modules/tasks/server/runner'
import { canRunTasks, getTaskRuntimeDeps } from '@/modules/tasks/server/runtime-deps'

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
    if (isEngineConfigured()) {
      await enqueueDispatch('cron')
      return NextResponse.json({ engine: 'trigger.dev', dispatch: 'enqueued' })
    }
    if (!canRunTasks()) {
      // No model: still expire approvals and time out tasks, and run approved actions.
      const swept = await sweepTaskQueue(getAdminClient())
      return NextResponse.json({ ...swept, tasks: 'not_configured' })
    }

    const deps = getTaskRuntimeDeps()
    const outcomes: Record<string, number> = {}
    const result = await dispatchDueTasks({
      admin: deps.admin,
      integrations: canRunIntegrations() ? getIntegrationRuntime() : null,
      // Inline: run up to three due tasks in this request (each claims its own task).
      start: async (due) => {
        for (const task of due.slice(0, 3)) {
          const { results } = await processEmployeeTasks(deps, 1, task.taskId)
          for (const run of results) outcomes[run.status] = (outcomes[run.status] ?? 0) + 1
        }
      },
    })
    return NextResponse.json({ engine: 'inline', ...result, outcomes })
  } catch (error) {
    console.error('[tasks] cron run failed', redact(error))
    return NextResponse.json({ error: 'Run failed' }, { status: 500 })
  }
}

// The execution engine boundary (Trigger.dev SDK mocked — no Trigger.dev
// project was reachable from where this was written): requests only enqueue
// work when the engine is configured, one job per due task with a key per
// task state and a per-organization concurrency key, the dispatcher sweeps
// before starting anything and never claims tasks itself, and the job
// wrappers claim exactly their task and nudge a dispatch when a task finishes.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeSupabase } from '../helpers/fake-supabase'

const sdk = vi.hoisted(() => ({
  configure: vi.fn(),
  trigger: vi.fn(async () => ({ id: 'run_1' })),
  batchTrigger: vi.fn(async () => ({ batchId: 'batch_1' })),
}))
const env = vi.hoisted(() => ({ engine: true }))
const after = vi.hoisted(() => vi.fn((callback: () => Promise<void>) => void callback()))
const runner = vi.hoisted(() => ({ processEmployeeTasks: vi.fn() }))

vi.mock('@trigger.dev/sdk', () => ({
  configure: sdk.configure,
  tasks: { trigger: sdk.trigger, batchTrigger: sdk.batchTrigger },
  logger: { info: vi.fn(), warn: vi.fn() },
  queue: (options: unknown) => options,
  task: (definition: unknown) => definition,
  schedules: { task: (definition: unknown) => definition },
}))
vi.mock('next/server', () => ({ after }))
vi.mock('@/lib/env/server', () => ({
  isFeatureConfigured: (feature: string) => (feature === 'backgroundJobs' ? env.engine : true),
  requireFeature: () => ({ secretKey: 'tr_dev_example', projectRef: 'proj_example' }),
}))
vi.mock('@/modules/tasks/server/runner', () => runner)
vi.mock('@/modules/tasks/server/runtime-deps', () => ({ canRunTasks: () => true, getTaskRuntimeDeps: () => ({ admin: {}, integrations: null }) }))
vi.mock('@/modules/integrations/server/executor', () => ({ processApprovedExecutions: vi.fn(async () => ({ claimed: 2, results: [] })) }))
vi.mock('@/modules/integrations/server/runtime', () => ({ canRunIntegrations: () => false, getIntegrationRuntime: vi.fn() }))

const engine = await import('@/modules/tasks/server/engine')
const { scheduleTaskProcessing } = await import('@/modules/tasks/server/scheduling')
const { dispatchDueTasks } = await import('@/modules/tasks/server/dispatch')
const jobs = await import('../../trigger/employee-tasks')

const ORG = 'a1000000-0000-4000-8000-000000000000'

beforeEach(() => {
  vi.clearAllMocks()
  env.engine = true
})

describe('enqueueing work', () => {
  it('with the engine, a request only enqueues a dispatch — no task runs in the request', async () => {
    scheduleTaskProcessing({ reason: 'assigned' })
    await vi.waitFor(() => expect(sdk.trigger).toHaveBeenCalledWith('employee-tasks.dispatch', { reason: 'assigned' }, expect.anything()))
    expect(sdk.configure).toHaveBeenCalledWith({ secretKey: 'tr_dev_example' })
    expect(runner.processEmployeeTasks).not.toHaveBeenCalled()
  })

  it('without the engine, one bounded segment runs after the response', async () => {
    env.engine = false
    runner.processEmployeeTasks.mockResolvedValue({ claimed: 0, results: [] })
    scheduleTaskProcessing()
    await vi.waitFor(() => expect(runner.processEmployeeTasks).toHaveBeenCalledWith(expect.anything(), 2))
    expect(sdk.trigger).not.toHaveBeenCalled()
  })

  it('starts one job per due task, keyed by task state, with the organization as concurrency key', async () => {
    await engine.startTaskJobs([
      { taskId: 't1', organizationId: ORG, version: '2026-10-19T05:00:00.000000+00:00' },
      { taskId: 't2', organizationId: ORG, version: '2026-10-19T05:00:01.000000+00:00' },
    ])
    expect(sdk.batchTrigger).toHaveBeenCalledWith('employee-tasks.run', [
      expect.objectContaining({
        payload: { taskId: 't1', organizationId: ORG },
        options: expect.objectContaining({ idempotencyKey: 'employee-task:t1:2026-10-19T05:00:00.000000+00:00', concurrencyKey: ORG }),
      }),
      expect.objectContaining({ payload: { taskId: 't2', organizationId: ORG } }),
    ])
    await engine.startTaskJobs([])
    expect(sdk.batchTrigger).toHaveBeenCalledTimes(1)
  })
})

describe('the dispatcher', () => {
  it('sweeps (approvals, deadlines) before listing due tasks, and hands them to start without claiming', async () => {
    const db = new FakeSupabase()
    const order: string[] = []
    db.rpcHandlers.expire_overdue_approvals = () => (order.push('expire'), { data: 1, error: null })
    db.rpcHandlers.time_out_overdue_tasks = () => (order.push('timeout'), { data: 2, error: null })
    db.tables.tasks = [
      { id: 'due', organization_id: ORG, employee_id: 'e', status: 'queued', scheduled_at: null, priority: 0, created_at: '1', updated_at: 'v1' },
      { id: 'person-action', organization_id: ORG, employee_id: null, status: 'queued', scheduled_at: null, priority: 0, created_at: '1', updated_at: 'v1' },
    ]
    const start = vi.fn(async () => void order.push('start'))
    const result = await dispatchDueTasks({ admin: db as never, integrations: null, start })
    expect(result).toEqual({ approvalsExpired: 1, tasksTimedOut: 2, actionsRun: 'not_configured', started: 1 })
    expect(start).toHaveBeenCalledWith([{ taskId: 'due', organizationId: ORG, version: 'v1' }])
    expect(order).toEqual(['expire', 'timeout', 'start'])
    expect(db.rpcCalls.map((call) => call.name)).not.toContain('claim_employee_tasks')
  })
})

describe('the engine jobs', () => {
  const run = jobs.runEmployeeTask as unknown as { run: (payload: { taskId: string; organizationId: string }) => Promise<unknown>; retry: unknown; maxDuration: number }

  it('claim exactly their task, with engine retries off (retries are attempts in Postgres)', async () => {
    runner.processEmployeeTasks.mockResolvedValue({ claimed: 1, results: [{ taskId: 't1', status: 'waiting_approval' }] })
    expect(await run.run({ taskId: 't1', organizationId: ORG })).toMatchObject({ claimed: 1 })
    expect(runner.processEmployeeTasks).toHaveBeenCalledWith(expect.anything(), 1, 't1')
    expect(run.retry).toEqual({ maxAttempts: 1 })
    expect(sdk.trigger).not.toHaveBeenCalled()
  })

  it('nudge a dispatch when a task finished (dependents may be released), and do nothing when the task isn’t claimable', async () => {
    runner.processEmployeeTasks.mockResolvedValue({ claimed: 1, results: [{ taskId: 't1', status: 'succeeded' }] })
    await run.run({ taskId: 't1', organizationId: ORG })
    expect(sdk.trigger).toHaveBeenCalledWith('employee-tasks.dispatch', { reason: 'task_finished' }, expect.anything())

    sdk.trigger.mockClear()
    runner.processEmployeeTasks.mockResolvedValue({ claimed: 0, results: [] })
    expect(await run.run({ taskId: 't2', organizationId: ORG })).toEqual({ claimed: 0 })
    expect(sdk.trigger).not.toHaveBeenCalled()
  })

  it('the schedule runs every minute', () => {
    expect((jobs.sweepEmployeeTasks as unknown as { cron: string }).cron).toBe('* * * * *')
  })
})

// Task Center rules: the controls a task's state allows (mirroring the SQL
// functions, pgTAP 010), what cancelling must disclose, and the list's
// filters.

import { describe, expect, it } from 'vitest'

import { parseListParams } from '@/lib/list-params'
import { cancellationDisclosure, formatDuration, periodStart, priorityLabel, TASK_LIST_SPEC, taskControls, uuidParam, type TaskControlState } from '@/modules/tasks/domain/task-center'

const state = (overrides: Partial<TaskControlState> = {}): TaskControlState => ({
  status: 'queued',
  cancelRequested: false,
  pauseRequested: false,
  attemptCount: 0,
  failureClass: null,
  failureCode: null,
  ...overrides,
})

describe('task controls', () => {
  it('offers pause, cancel, priority and reassignment on a queued task that hasn’t started', () => {
    expect(taskControls(state())).toEqual({ cancel: true, pause: true, resume: false, retry: false, changePriority: true, reassign: true })
  })

  it('a running task can be paused or cancelled; a pending pause can be withdrawn; nothing is offered while it is being cancelled', () => {
    expect(taskControls(state({ status: 'running', attemptCount: 1 }))).toMatchObject({ pause: true, cancel: true, resume: false, reassign: false })
    expect(taskControls(state({ status: 'running', attemptCount: 1, pauseRequested: true }))).toMatchObject({ pause: false, resume: true, cancel: true })
    expect(taskControls(state({ status: 'running', attemptCount: 1, cancelRequested: true }))).toMatchObject({ pause: false, resume: false, cancel: false })
  })

  it('a paused task can be resumed or cancelled, and reassigned only if it never started', () => {
    expect(taskControls(state({ status: 'paused' }))).toMatchObject({ resume: true, pause: false, cancel: true, reassign: true })
    expect(taskControls(state({ status: 'paused', attemptCount: 1 }))).toMatchObject({ reassign: false })
  })

  it('retry is offered only for failures a retry can fix', () => {
    expect(taskControls(state({ status: 'failed', failureClass: 'limit', failureCode: 'limit_reached' })).retry).toBe(true)
    expect(taskControls(state({ status: 'failed', failureClass: 'transient', failureCode: 'attempts_exhausted' })).retry).toBe(true)
    expect(taskControls(state({ status: 'failed', failureClass: 'task', failureCode: 'verification_failed' })).retry).toBe(false)
    expect(taskControls(state({ status: 'failed', failureClass: 'permanent', failureCode: 'not_recorded' })).retry).toBe(false)
  })

  it('finished tasks offer nothing but retry', () => {
    for (const status of ['succeeded', 'cancelled', 'skipped'] as const) {
      expect(taskControls(state({ status }))).toEqual({ cancel: false, pause: false, resume: false, retry: false, changePriority: false, reassign: false })
    }
  })
})

describe('what cancelling discloses', () => {
  it('lists completed changes and running actions, not reads, and counts what it withdraws', () => {
    const disclosure = cancellationDisclosure([
      { id: '1', toolKey: 'hubspot.contacts.search', risk: 'read', status: 'succeeded' },
      { id: '2', toolKey: 'hubspot.contacts.upsert', risk: 'write_external', status: 'succeeded' },
      { id: '3', toolKey: 'slack.messages.post', risk: 'write_external', status: 'executing' },
      { id: '4', toolKey: 'hubspot.notes.create', risk: 'write_external', status: 'awaiting_approval' },
      { id: '5', toolKey: 'hubspot.notes.create', risk: 'write_external', status: 'failed' },
    ])
    expect(disclosure.done.map((action) => action.id)).toEqual(['2'])
    expect(disclosure.inProgress.map((action) => action.id)).toEqual(['3'])
    expect(disclosure.withdrawn).toBe(1)
  })
})

describe('the task list', () => {
  it('parses filters, rejecting unknown values', () => {
    const list = parseListParams({ status: 'paused', failure: 'limit', period: '7d', sort: 'priority', page: '2' }, TASK_LIST_SPEC)
    expect(list).toMatchObject({ filters: { status: 'paused', failure: 'limit', period: '7d' }, sort: { column: 'priority', direction: 'asc' }, page: 2, from: 25 })
    expect(parseListParams({ status: 'hacked', failure: 'x', period: '1y' }, TASK_LIST_SPEC).filters).toEqual({})
  })

  it('accepts only UUIDs for employee and workflow filters', () => {
    expect(uuidParam({ employee: 'A2000000-0000-4000-8000-000000000001' }, 'employee')).toBe('a2000000-0000-4000-8000-000000000001')
    expect(uuidParam({ employee: "1' or '1'='1" }, 'employee')).toBeNull()
    expect(uuidParam({}, 'workflow')).toBeNull()
  })

  it('computes period starts and formats durations and priorities', () => {
    expect(periodStart('24h', new Date('2026-10-19T12:00:00Z')).toISOString()).toBe('2026-10-18T12:00:00.000Z')
    expect(formatDuration(450)).toBe('450 ms')
    expect(formatDuration(65_000)).toBe('1 min 5 s')
    expect(formatDuration(3 * 86_400_000 + 3_600_000)).toBe('3 days 1 h')
    expect([priorityLabel(50), priorityLabel(20), priorityLabel(0), priorityLabel(-20), priorityLabel(7)]).toEqual(['Urgent', 'High', 'Normal', 'Low', 'Normal (+7)'])
  })
})

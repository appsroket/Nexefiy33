// Task Center rules (Zod-free: client components import this): the list's
// filters and sorting, which controls a task's state allows, and what a
// person must be told before cancelling — actions that already happened stay
// done. The database functions enforce the same states; this decides what
// the page offers.

import type { ListSpec, SearchParams } from '@/lib/list-params'

import { FAILURE_CLASSES, type FailureClass } from './failures'
import { TASK_STATUSES, type TaskStatus } from './labels'

export const TASK_SORT_COLUMNS = ['created_at', 'priority', 'completed_at'] as const
export type TaskSortColumn = (typeof TASK_SORT_COLUMNS)[number]

export const TASK_PERIODS = ['24h', '7d', '30d', '90d'] as const
export type TaskPeriod = (typeof TASK_PERIODS)[number]

export const TASK_PERIOD_LABELS: Record<TaskPeriod, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}

export type TaskFilterParam = 'status' | 'failure' | 'period'

export const TASK_LIST_SPEC: ListSpec<TaskSortColumn, TaskFilterParam> = {
  sortable: TASK_SORT_COLUMNS,
  defaultSort: { column: 'created_at', direction: 'desc' },
  filters: { status: TASK_STATUSES, failure: FAILURE_CLASSES, period: TASK_PERIODS },
  pageSize: 25,
}

const PERIOD_MS: Record<TaskPeriod, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 }

export function periodStart(period: TaskPeriod, now: Date): Date {
  return new Date(now.getTime() - PERIOD_MS[period])
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A UUID-valued filter (employee, workflow); anything else is ignored. */
export function uuidParam(params: SearchParams, name: string): string | null {
  const raw = params[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && UUID.test(value) ? value.toLowerCase() : null
}

export const PRIORITY_OPTIONS = [
  { value: 50, label: 'Urgent' },
  { value: 20, label: 'High' },
  { value: 0, label: 'Normal' },
  { value: -20, label: 'Low' },
] as const

export function priorityLabel(priority: number): string {
  if (priority >= 50) return 'Urgent'
  if (priority >= 20) return 'High'
  if (priority > -20) return priority === 0 ? 'Normal' : `Normal (${priority > 0 ? '+' : ''}${priority})`
  return 'Low'
}

export const TIMEOUT_OPTIONS = [
  { value: 60, label: '1 hour' },
  { value: 240, label: '4 hours' },
  { value: 1440, label: '1 day' },
  { value: 4320, label: '3 days' },
  { value: 10080, label: '7 days' },
] as const
export const DEFAULT_TIMEOUT_MINUTES = 4320

export interface TaskControlState {
  status: TaskStatus
  cancelRequested: boolean
  pauseRequested: boolean
  attemptCount: number
  failureClass: FailureClass | null
  failureCode: string | null
}

export interface TaskControls {
  cancel: boolean
  pause: boolean
  resume: boolean
  retry: boolean
  changePriority: boolean
  reassign: boolean
}

const UNRETRYABLE_CODES = ['not_found', 'invalid_configuration', 'not_recorded']
const FINISHED: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled', 'skipped']

/** What an operator may do to a task in this state (mirrors the SQL functions). */
export function taskControls(state: TaskControlState): TaskControls {
  const finished = FINISHED.includes(state.status)
  const stopping = state.status === 'running' && state.cancelRequested
  return {
    cancel: !finished && !stopping,
    pause: ['pending', 'queued', 'waiting_approval', 'blocked'].includes(state.status) || (state.status === 'running' && !state.cancelRequested && !state.pauseRequested),
    resume: state.status === 'paused' || (state.status === 'running' && state.pauseRequested),
    retry: state.status === 'failed' && state.failureClass !== 'task' && !UNRETRYABLE_CODES.includes(state.failureCode ?? ''),
    changePriority: !finished,
    reassign: ['pending', 'queued', 'paused'].includes(state.status) && state.attemptCount === 0,
  }
}

export interface DisclosureAction {
  id: string
  toolKey: string
  risk: string
  status: string
}

/**
 * Before cancelling: which actions already changed something outside
 * Nexefiy (cancelling doesn't undo them), and which are running right now
 * (they can't be stopped and may still complete). Reads aren't listed.
 */
export function cancellationDisclosure(actions: readonly DisclosureAction[]): { done: DisclosureAction[]; inProgress: DisclosureAction[]; withdrawn: number } {
  const changes = (action: DisclosureAction) => action.risk !== 'read'
  return {
    done: actions.filter((action) => action.status === 'succeeded' && changes(action)),
    inProgress: actions.filter((action) => action.status === 'executing'),
    withdrawn: actions.filter((action) => ['proposed', 'awaiting_approval', 'approved'].includes(action.status)).length,
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} days ${hours % 24} h`
}

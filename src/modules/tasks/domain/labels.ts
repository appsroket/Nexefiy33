// Display labels for tasks (Zod-free: client components import this).

import type { FailureClass } from './failures'
import type { CheckStatus, Verification, VerificationCheck } from './verification'

export const TASK_STATUSES = ['pending', 'queued', 'running', 'waiting_approval', 'blocked', 'succeeded', 'failed', 'cancelled', 'skipped'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const TASK_STATUS_DISPLAY: Record<TaskStatus, { label: string; tone: Tone; description: string }> = {
  pending: { label: 'Pending', tone: 'neutral', description: 'Not queued yet.' },
  queued: { label: 'Queued', tone: 'info', description: 'Waiting for the employee to pick it up.' },
  running: { label: 'Running', tone: 'info', description: 'The employee is working on it.' },
  waiting_approval: { label: 'Waiting for approval', tone: 'warning', description: 'An action needs a person’s approval before the employee continues.' },
  blocked: { label: 'Needs your reply', tone: 'warning', description: 'The employee escalated and is waiting for an answer.' },
  succeeded: { label: 'Done', tone: 'success', description: 'The employee finished the task.' },
  failed: { label: 'Failed', tone: 'danger', description: 'The task didn’t finish.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', description: 'The task was stopped.' },
  skipped: { label: 'Skipped', tone: 'neutral', description: 'The task wasn’t run.' },
}

/** Tasks that can still change on their own (the page refreshes while it shows one). */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['pending', 'queued', 'running']

export const VERIFICATION_DISPLAY: Record<Verification['status'], { label: string; tone: Tone }> = {
  verified: { label: 'Verified', tone: 'success' },
  needs_review: { label: 'Needs review', tone: 'warning' },
  failed: { label: 'Verification failed', tone: 'danger' },
}

export const CHECK_LABELS: Record<VerificationCheck['key'], string> = {
  receipts_verified: 'Cited actions really happened',
  claims_backed: 'Claims backed by recorded actions',
  actions_settled: 'No action still pending',
  actions_failed: 'No action failed',
  report_filed: 'Structured report filed',
}

export const CHECK_TONE: Record<CheckStatus, Tone> = { passed: 'success', needs_review: 'warning', failed: 'danger' }

export const FAILURE_CLASS_LABELS: Record<FailureClass, string> = {
  transient: 'Temporary problem',
  permanent: 'Can’t be retried',
  limit: 'Limit reached',
  task: 'Task not completed',
}

export const ACTION_STATUS_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  awaiting_approval: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  executing: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Blocked',
  cancelled: 'Cancelled',
}

// Display mapping for every status column in the schema. Labels are plain
// language; tones drive colour, but every badge also shows its label so status
// is never conveyed by colour alone. tests/app/status.test.ts checks that each
// kind covers exactly the values allowed by its table's check constraint.

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface StatusDisplay {
  label: string
  tone: StatusTone
}

export const STATUS_DISPLAY = {
  approval: {
    pending: { label: 'Waiting for approval', tone: 'warning' },
    approved: { label: 'Approved', tone: 'success' },
    rejected: { label: 'Rejected', tone: 'danger' },
    expired: { label: 'Expired', tone: 'neutral' },
    cancelled: { label: 'Cancelled', tone: 'neutral' },
  },
  task: {
    pending: { label: 'Not started', tone: 'neutral' },
    queued: { label: 'Queued', tone: 'neutral' },
    running: { label: 'Running', tone: 'info' },
    waiting_approval: { label: 'Waiting for approval', tone: 'warning' },
    blocked: { label: 'Blocked', tone: 'warning' },
    succeeded: { label: 'Completed', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
    cancelled: { label: 'Cancelled', tone: 'neutral' },
    skipped: { label: 'Skipped', tone: 'neutral' },
  },
  workflowRun: {
    queued: { label: 'Queued', tone: 'neutral' },
    running: { label: 'Running', tone: 'info' },
    waiting: { label: 'Waiting', tone: 'warning' },
    succeeded: { label: 'Completed', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
    cancelled: { label: 'Cancelled', tone: 'neutral' },
    rejected: { label: 'Rejected', tone: 'danger' },
    timed_out: { label: 'Timed out', tone: 'danger' },
  },
  toolExecution: {
    proposed: { label: 'Proposed', tone: 'neutral' },
    awaiting_approval: { label: 'Waiting for approval', tone: 'warning' },
    approved: { label: 'Approved', tone: 'info' },
    rejected: { label: 'Rejected', tone: 'danger' },
    executing: { label: 'Running', tone: 'info' },
    succeeded: { label: 'Completed', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
    skipped: { label: 'Skipped', tone: 'neutral' },
    cancelled: { label: 'Cancelled', tone: 'neutral' },
  },
  integration: {
    pending: { label: 'Setting up', tone: 'neutral' },
    connected: { label: 'Connected', tone: 'success' },
    needs_reauth: { label: 'Needs reconnecting', tone: 'warning' },
    error: { label: 'Error', tone: 'danger' },
    revoked: { label: 'Disconnected', tone: 'neutral' },
  },
  employee: {
    draft: { label: 'Draft', tone: 'neutral' },
    active: { label: 'Active', tone: 'success' },
    paused: { label: 'Paused', tone: 'warning' },
    archived: { label: 'Archived', tone: 'neutral' },
  },
  workflow: {
    draft: { label: 'Draft', tone: 'neutral' },
    active: { label: 'Active', tone: 'success' },
    paused: { label: 'Paused', tone: 'warning' },
    archived: { label: 'Archived', tone: 'neutral' },
  },
  knowledgeSource: {
    pending: { label: 'Waiting to process', tone: 'neutral' },
    processing: { label: 'Processing', tone: 'info' },
    ready: { label: 'Ready', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
    archived: { label: 'Archived', tone: 'neutral' },
  },
  member: {
    active: { label: 'Active', tone: 'success' },
    revoked: { label: 'Removed', tone: 'neutral' },
  },
  invitation: {
    pending: { label: 'Invited', tone: 'info' },
    accepted: { label: 'Accepted', tone: 'success' },
    revoked: { label: 'Revoked', tone: 'neutral' },
    expired: { label: 'Expired', tone: 'neutral' },
  },
} as const satisfies Record<string, Record<string, StatusDisplay>>

export type StatusKind = keyof typeof STATUS_DISPLAY

/** The table whose `status` check constraint each kind mirrors. */
export const STATUS_TABLES: Record<StatusKind, string> = {
  approval: 'approval_requests',
  task: 'tasks',
  workflowRun: 'workflow_runs',
  toolExecution: 'tool_executions',
  integration: 'integrations',
  employee: 'ai_employees',
  workflow: 'workflow_definitions',
  knowledgeSource: 'knowledge_sources',
  member: 'organization_members',
  invitation: 'organization_invitations',
}

/** Unknown statuses render as a neutral badge with a readable label, never a crash. */
export function statusDisplay(kind: StatusKind, status: string): StatusDisplay {
  const known = (STATUS_DISPLAY[kind] as Record<string, StatusDisplay>)[status]
  if (known) return known
  const label = status.replace(/_/g, ' ')
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: 'neutral' }
}

// Display helpers for employee pages. Zod-free (client components import it).

import type { RunOutcome, TestRunResult } from '../domain/types'

export const RUN_RESULT_DISPLAY: Record<TestRunResult, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  running: { label: 'Running', tone: 'info' },
  passed: { label: 'Passed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  needs_review: { label: 'Needs review', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
}

export const OUTCOME_LABELS: Record<RunOutcome, string> = {
  completed: 'Answered',
  limit_reached: 'Stopped at a limit',
  escalated: 'Escalated',
  refused: 'Declined by the model',
  error: 'Failed',
}

export const DECISION_LABELS: Record<'allow' | 'require_approval' | 'deny' | 'refused', string> = {
  allow: 'Would run',
  require_approval: 'Would wait for approval',
  deny: 'Blocked by a rule',
  refused: 'Refused',
}

export const RISK_TEXT: Record<'read' | 'write_internal' | 'write_external' | 'sensitive', string> = {
  read: 'Reads data',
  write_internal: 'Changes data in Nexefiy',
  write_external: 'Changes data or sends something outside Nexefiy',
  sensitive: 'Sensitive',
}

export const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'

export function toLines(items: readonly string[]): string {
  return items.join('\n')
}

export function fromLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

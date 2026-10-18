// Which status changes the pages offer. The database (change_employee_status)
// is the authority and repeats every check; this only decides which buttons
// to show. Keep the two in sync (tests/employees/domain.test.ts).

import { hasMinRole, type OrganizationRole } from '@/lib/supabase/types'

import type { LifecycleState, TestStatus } from './types'

export const LIFECYCLE_ACTIONS = ['start_testing', 'return_to_draft', 'activate', 'pause', 'resume', 'archive', 'restore'] as const
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number]

export const LIFECYCLE_DISPLAY: Record<LifecycleState, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; meaning: string }> = {
  draft: { label: 'Draft', tone: 'neutral', meaning: 'Being configured. It can’t run.' },
  testing: { label: 'Testing', tone: 'info', meaning: 'Being tested in the playground. It can’t run for real yet.' },
  active: { label: 'Active', tone: 'success', meaning: 'Its activated version can be given work.' },
  paused: { label: 'Paused', tone: 'warning', meaning: 'Temporarily stopped. Nothing runs until it is resumed.' },
  archived: { label: 'Archived', tone: 'neutral', meaning: 'Retired. Kept for history; restore it to edit again.' },
}

export const ACTION_LABELS: Record<LifecycleAction, string> = {
  start_testing: 'Start testing',
  return_to_draft: 'Back to draft',
  activate: 'Activate',
  pause: 'Pause',
  resume: 'Resume',
  archive: 'Archive',
  restore: 'Restore',
}

/** The minimum role for each action (pausing is a safety stop any operator can use). */
export const ACTION_MIN_ROLE: Record<LifecycleAction, OrganizationRole> = {
  start_testing: 'operator',
  return_to_draft: 'operator',
  activate: 'admin',
  pause: 'operator',
  resume: 'admin',
  archive: 'admin',
  restore: 'admin',
}

const FROM: Record<LifecycleAction, readonly LifecycleState[]> = {
  start_testing: ['draft'],
  return_to_draft: ['testing'],
  activate: ['draft', 'testing', 'active', 'paused'],
  pause: ['active'],
  resume: ['paused'],
  archive: ['draft', 'testing', 'active', 'paused'],
  restore: ['archived'],
}

export interface LifecycleView {
  state: LifecycleState
  role: OrganizationRole
  /** Test status of the latest saved version. */
  currentTestStatus: TestStatus
  /** True when the latest saved version is already the active one. */
  currentIsActive: boolean
}

export function availableActions({ state, role, currentTestStatus, currentIsActive }: LifecycleView): LifecycleAction[] {
  return LIFECYCLE_ACTIONS.filter((action) => {
    if (!FROM[action].includes(state) || !hasMinRole(role, ACTION_MIN_ROLE[action])) return false
    // Activation is offered for a newer version only, and only once its tests passed.
    if (action === 'activate') return !currentIsActive && currentTestStatus === 'passed'
    return true
  })
}

/** Why "Activate" isn't offered, for the explanation next to the controls. */
export function activationHint(view: LifecycleView): string | null {
  if (view.state === 'archived') return 'Restore this employee before activating it.'
  if (view.currentIsActive) return null
  if (!hasMinRole(view.role, 'admin')) return 'An admin or owner activates employees.'
  switch (view.currentTestStatus) {
    case 'passed':
      return null
    case 'untested':
      return 'Run tests in the playground first: a version is activated only after its tests pass.'
    case 'incomplete':
      return 'Run every saved test case on the latest version before activating it.'
    case 'failed':
      return 'Some tests are failing on the latest version. Fix the configuration or the test, then run them again.'
    case 'needs_review':
      return 'Review the playground runs waiting for a verdict before activating.'
  }
}

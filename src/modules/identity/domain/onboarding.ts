// Onboarding progress, derived from what actually exists in the workspace
// rather than stored separately, so it can never claim a step that didn't
// happen. Planned steps are listed but never counted as done.

import type { OrganizationRole } from '@/lib/supabase/types'

import { canEditWorkspace, canManageMembers } from './members'

export interface OnboardingFacts {
  role: OrganizationRole
  hasName: boolean
  hasCompanyDetails: boolean
  /** Another active member, or an invitation that is still pending. */
  hasInvitedSomeone: boolean
}

export type OnboardingStepStatus = 'done' | 'todo' | 'planned'

export interface OnboardingStep {
  id: string
  title: string
  description: string
  status: OnboardingStepStatus
  href?: string
}

export interface OnboardingProgress {
  steps: OnboardingStep[]
  completed: number
  /** Steps this person can complete today (excludes planned ones). */
  total: number
}

export function onboardingProgress(facts: OnboardingFacts): OnboardingProgress {
  const steps: OnboardingStep[] = [
    {
      id: 'workspace',
      title: 'Create a workspace',
      description: 'Your workspace keeps your company’s data separate from everyone else’s.',
      status: 'done',
    },
    {
      id: 'profile',
      title: 'Add your name',
      description: 'So teammates know who did what.',
      status: facts.hasName ? 'done' : 'todo',
      href: '/app/account',
    },
  ]
  if (canEditWorkspace(facts.role)) {
    steps.push({
      id: 'company',
      title: 'Describe your company',
      description: 'Your industry, website and time zone.',
      status: facts.hasCompanyDetails ? 'done' : 'todo',
      href: '/app/settings',
    })
  }
  if (canManageMembers(facts.role)) {
    steps.push({
      id: 'team',
      title: 'Invite a teammate',
      description: 'Give each person the role they need, from viewer to admin.',
      status: facts.hasInvitedSomeone ? 'done' : 'todo',
      href: '/app/settings/members',
    })
  }
  steps.push(
    {
      id: 'employee',
      title: 'Set up your first AI employee',
      description: 'Not available yet.',
      status: 'planned',
    },
    {
      id: 'integration',
      title: 'Connect a business app',
      description: 'Not available yet.',
      status: 'planned',
    },
  )

  const actionable = steps.filter((step) => step.status !== 'planned')
  return { steps, completed: actionable.filter((step) => step.status === 'done').length, total: actionable.length }
}

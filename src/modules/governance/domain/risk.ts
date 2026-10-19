// How consequential an action is. Every action declares a category (what it
// does in the world); the category fixes its risk tier, and the tier fixes the
// minimum approver, the role needed to let it run without approval, whether
// someone other than the requester must approve, and how long an approval
// stays valid. Policies can make any of these stricter; only a policy written
// by a role allowed to authorize the tier can waive approval (risk-tier
// "authorizer"), and only for the exact actions it names.
//
// Pure and Zod-free: client components import it.

import type { OrganizationRole } from '@/lib/supabase/types'

export const ACTION_CATEGORIES = [
  'read',
  'draft',
  'internal_update',
  'record_change',
  'external_message',
  'financial',
  'personnel',
  'destructive',
] as const
export type ActionCategory = (typeof ACTION_CATEGORIES)[number]

export const RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const
export type RiskTier = (typeof RISK_TIERS)[number]

export type ApproverRole = Exclude<OrganizationRole, 'viewer'>

export interface CategoryInfo {
  label: string
  tier: RiskTier
  description: string
  /** Real-world examples (some have no connector yet; see `available`). */
  examples: string[]
  /** Whether Nexefiy has an action in this category today. */
  available: boolean
}

export const ACTION_CATEGORY_INFO: Record<ActionCategory, CategoryInfo> = {
  read: {
    label: 'Read data',
    tier: 'low',
    description: 'Looks something up. Changes nothing anywhere.',
    examples: ['Search CRM contacts', 'List Slack channels', 'Search the knowledge base'],
    available: true,
  },
  draft: {
    label: 'Draft',
    tier: 'low',
    description: 'Prepares text or a plan inside Nexefiy for a person to review. Nothing is sent.',
    examples: ['Draft a reply to a customer', 'Draft a campaign brief'],
    available: true,
  },
  internal_update: {
    label: 'Update inside Nexefiy',
    tier: 'medium',
    description: 'Changes records in this workspace only.',
    examples: ['Record a task result', 'Hand work to the next workflow step'],
    available: true,
  },
  record_change: {
    label: 'Change business records',
    tier: 'medium',
    description: 'Creates or changes records in a connected system.',
    examples: ['Create or update a CRM contact', 'Add a note to a CRM record'],
    available: true,
  },
  external_message: {
    label: 'Send a message',
    tier: 'high',
    description: 'Sends something people will read. It can’t be unsent.',
    examples: ['Post to a Slack channel', 'Email a customer (no email connector yet)'],
    available: true,
  },
  financial: {
    label: 'Move money',
    tier: 'critical',
    description: 'Charges, refunds, pays or changes invoices.',
    examples: ['Issue a refund', 'Send or void an invoice'],
    available: false,
  },
  personnel: {
    label: 'Change people records',
    tier: 'critical',
    description: 'Changes pay, employment or access for people.',
    examples: ['Change payroll', 'Change someone’s role or access'],
    available: false,
  },
  destructive: {
    label: 'Delete or overwrite',
    tier: 'critical',
    description: 'Deletes or irreversibly overwrites important data.',
    examples: ['Delete CRM records', 'Delete files or a database table'],
    available: false,
  },
}

export interface TierInfo {
  label: string
  /** Whether the action needs approval unless a policy explicitly permits it. */
  consequential: boolean
  /** Lowest role that may approve it. */
  approverRole: ApproverRole
  /** Lowest role whose policy may let it run without approval. */
  authorizerRole: 'admin' | 'owner'
  /** Someone other than the requester must approve. */
  separateApprover: boolean
  /** Longest an approval stays valid. */
  maxApprovalHours: number
  tone: 'success' | 'info' | 'warning' | 'danger'
}

export const RISK_TIER_INFO: Record<RiskTier, TierInfo> = {
  low: { label: 'Low', consequential: false, approverRole: 'operator', authorizerRole: 'admin', separateApprover: false, maxApprovalHours: 72, tone: 'success' },
  medium: { label: 'Medium', consequential: true, approverRole: 'operator', authorizerRole: 'admin', separateApprover: false, maxApprovalHours: 72, tone: 'info' },
  high: { label: 'High', consequential: true, approverRole: 'admin', authorizerRole: 'admin', separateApprover: false, maxApprovalHours: 48, tone: 'warning' },
  critical: { label: 'Critical', consequential: true, approverRole: 'owner', authorizerRole: 'owner', separateApprover: true, maxApprovalHours: 24, tone: 'danger' },
}

const ROLE_RANK: Record<OrganizationRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 }

export function roleAtLeast(role: OrganizationRole | null | undefined, minimum: OrganizationRole): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[minimum]
}

export function higherRole<R extends OrganizationRole>(a: R, b: R): R {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b
}

export function tierOf(category: ActionCategory): RiskTier {
  return ACTION_CATEGORY_INFO[category].tier
}

export function isConsequential(category: ActionCategory): boolean {
  return RISK_TIER_INFO[tierOf(category)].consequential
}

/** The tier that ranks higher. */
export function higherTier(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_TIERS.indexOf(a) >= RISK_TIERS.indexOf(b) ? a : b
}

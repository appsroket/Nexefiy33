// Shared vocabulary of the integration framework. Pure and free of Zod so
// client components can import it; connector definitions with their Zod
// schemas live in ../connectors (server code).

import type { ActionCategory } from '@/modules/governance/domain/risk'

export const RISK_LEVELS = ['read', 'write_internal', 'write_external', 'sensitive'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export const APPROVAL_MODES = ['allow', 'require_approval', 'deny'] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export type IntegrationStatus = 'pending' | 'connected' | 'needs_reauth' | 'error' | 'revoked'
export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'

export const PROVIDER_KEYS = ['hubspot', 'slack'] as const
export type ProviderKey = (typeof PROVIDER_KEYS)[number]

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === 'string' && (PROVIDER_KEYS as readonly string[]).includes(value)
}

/**
 * How an action's approval requirement relates to the per-connection setting:
 * - none: runs without approval unless an admin or policy requires it;
 * - default_required: needs approval unless an admin explicitly allows it;
 * - always: always needs approval; admins and policies cannot relax it.
 */
export type ApprovalRequirement = 'none' | 'default_required' | 'always'

/**
 * Whether repeating an action can cause a duplicate effect at the provider:
 * - read_only: no side effects, safe to repeat;
 * - natural_key: the provider deduplicates on a unique value in the input
 *   (e.g. a contact's email), so a repeat finds the earlier result;
 * - not_idempotent: a repeat may duplicate the effect; the action is never
 *   sent again once it may have reached the provider.
 */
export type IdempotencyStrategy =
  | { kind: 'read_only' }
  | { kind: 'natural_key'; key: string; description: string }
  | { kind: 'not_idempotent'; description: string }

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface RateLimitRule {
  /** Counter name; actions sharing a provider limit share a bucket. */
  bucket: string
  limit: number
  windowSeconds: number
  /** Where the number comes from, for the connector page. */
  source: string
}

export type AuthKind = 'oauth2'

/** Serializable description of an action, for pages and the test console. */
export interface ActionSummary {
  key: string
  title: string
  description: string
  risk: RiskLevel
  category: ActionCategory
  approval: ApprovalRequirement
  defaultApprovalMode: ApprovalMode
  scopes: string[]
  idempotency: IdempotencyStrategy
  timeoutMs: number
  retry: RetryPolicy
  rateLimit: RateLimitRule
  inputSchema: unknown
  outputSchema: unknown
  exampleInput: Record<string, unknown>
}

/** Serializable description of a connector. */
export interface ConnectorSummary {
  provider: ProviderKey
  displayName: string
  category: 'crm' | 'communication'
  description: string
  docsUrl: string
  auth: {
    kind: AuthKind
    scopes: string[]
    tokenRefresh: 'refresh_token' | 'when_rotation_enabled'
    revocation: string
  }
  actions: ActionSummary[]
  /** Feature flag (env) that must be configured for connections to work. */
  configured: boolean
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  read: 'Read only',
  write_internal: 'Changes Nexefiy data',
  write_external: 'Changes data in another app',
  sensitive: 'Sensitive',
}

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  allow: 'Runs without approval',
  require_approval: 'Needs approval',
  deny: 'Blocked',
}

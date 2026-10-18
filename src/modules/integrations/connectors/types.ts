// The contract every connector implements. A connector is declarative: it
// states its provider, authentication, scopes, rate limits, and for each
// action the input/output schemas, risk, approval requirement, timeout, retry
// behavior and idempotency strategy. The framework (../server) enforces all of
// it — connectors never check permissions, policies or approvals themselves.
//
// Server code only (Zod schemas and provider calls).

import type { z } from 'zod'

import type { OptionalFeatureKey } from '@/lib/env/catalog'

import type { IntegrationError } from '../domain/errors'
import type {
  ApprovalRequirement,
  IdempotencyStrategy,
  ProviderKey,
  RateLimitRule,
  RetryPolicy,
  RiskLevel,
} from '../domain/types'

// --- HTTP ------------------------------------------------------------------

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  url: string
  headers?: Record<string, string>
  /** Sent as application/json. */
  json?: unknown
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>
  /** Rate-limit buckets this request counts against (default: the connector's default bucket). */
  rateLimitBuckets?: string[]
}

export interface HttpResponse {
  status: number
  headers: Headers
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  body: unknown
}

/**
 * Sends one request. Throws IntegrationError for timeouts, network failures
 * and local rate-limit refusals; returns every HTTP response (including 4xx
 * and 5xx) for the connector to interpret.
 */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>
}

// --- Credentials -----------------------------------------------------------

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** ISO timestamp; absent when the token does not expire. */
  expiresAt?: string
  scopes: string[]
}

export interface ConnectedAccount {
  externalAccountId: string
  label: string
  /** Non-secret facts shown on the connection page (ids, names). */
  metadata: Record<string, string | number | boolean | null>
  scopes?: string[]
}

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export interface OAuthDefinition {
  kind: 'oauth2'
  authorizeUrl: string
  scopeSeparator: ' ' | ','
  /** Requested on every connection, in addition to the actions' scopes. */
  baseScopes: readonly string[]
  /** How access tokens are renewed. */
  tokenRefresh: 'refresh_token' | 'when_rotation_enabled'
  /** What disconnecting does at the provider. */
  revocation: string
  authorizeParams?: Record<string, string>
  exchangeCode(http: HttpClient, client: OAuthClient, params: { code: string; redirectUri: string }): Promise<{
    tokens: TokenSet
    account: ConnectedAccount
  }>
  refresh(http: HttpClient, client: OAuthClient, refreshToken: string): Promise<TokenSet>
  /** Revokes the grant at the provider. Throws IntegrationError when it couldn't. */
  revoke(http: HttpClient, client: OAuthClient, tokens: TokenSet): Promise<void>
}

// --- Actions ---------------------------------------------------------------

export interface ConnectionInfo {
  id: string
  organizationId: string
  externalAccountId: string
  metadata: Record<string, unknown>
}

export interface ActionContext {
  http: HttpClient
  accessToken: string
  connection: ConnectionInfo
  signal: AbortSignal
}

export interface ActionDefinition<I = unknown, O = unknown> {
  /** "<provider>.<object>.<verb>"; also the tool key employees use. */
  key: string
  title: string
  description: string
  input: z.ZodType<I>
  output: z.ZodType<O>
  scopes: readonly string[]
  risk: RiskLevel
  approval: ApprovalRequirement
  idempotency: IdempotencyStrategy
  /** Per-attempt time limit for the whole action. */
  timeoutMs: number
  retry: RetryPolicy
  /** The main limit this action counts against (shown on the connector page). */
  rateLimitBucket: string
  exampleInput: Record<string, unknown>
  /** One line for approvers and task titles. Must not contain secrets. */
  summarize(input: I): string
  /** What is kept on the execution record (members can read it). Default: the full input. */
  redactInput?(input: I): Record<string, unknown>
  /** What is kept of the result. Default: the full output. */
  redactOutput?(output: O): Record<string, unknown>
  execute(context: ActionContext, input: I): Promise<O>
}

// --- Connector -------------------------------------------------------------

export interface HealthResult {
  status: 'healthy' | 'degraded'
  message: string
  /** Scopes the provider reports for the token, when it does. */
  grantedScopes?: string[]
}

export interface ConnectorDefinition {
  provider: ProviderKey
  displayName: string
  category: 'crm' | 'communication'
  description: string
  docsUrl: string
  /** Environment feature holding the OAuth client credentials. */
  feature: Extract<OptionalFeatureKey, 'hubspotIntegration' | 'slackIntegration'>
  auth: OAuthDefinition
  /** Rate-limit rules by bucket prefix (the part before ":"). */
  rateLimits: Record<string, RateLimitRule>
  defaultRateLimitBucket: string
  /** Default per-request time limit for provider calls. */
  requestTimeoutMs: number
  healthCheck(context: ActionContext): Promise<HealthResult>
  /** Turns a provider response that isn't a success into a normalized error. */
  normalizeError(response: HttpResponse): IntegrationError
  // Heterogeneous actions: each one's input/output types are checked where it is defined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: readonly ActionDefinition<any, any>[]
}

/** Identity helper that keeps an action's input/output types linked. */
export function defineAction<I, O>(action: ActionDefinition<I, O>): ActionDefinition<I, O> {
  return action
}

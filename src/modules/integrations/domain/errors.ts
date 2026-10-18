// Normalized integration errors. Every provider failure is translated into one
// of these codes so callers, retries, health checks and the UI handle HubSpot
// and Slack the same way. Pure: no I/O, no provider specifics.

import { redactString } from '@/lib/logging/redact'

export const INTEGRATION_ERROR_CODES = [
  'invalid_input',
  'not_configured',
  'not_connected',
  'reauth_required',
  'insufficient_scope',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'timeout',
  'unavailable',
  'provider_error',
  'outcome_unknown',
  'action_disabled',
  'denied_by_policy',
] as const

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number]

interface CodeInfo {
  /** A later attempt might succeed without anyone changing anything. */
  retryable: boolean
  /** Safe message shown when the provider's own message isn't useful. */
  message: string
}

export const ERROR_CODE_INFO: Record<IntegrationErrorCode, CodeInfo> = {
  invalid_input: { retryable: false, message: 'The input isn’t valid for this action.' },
  not_configured: { retryable: false, message: 'This integration isn’t set up on this deployment.' },
  not_connected: { retryable: false, message: 'This connection isn’t active. Reconnect it first.' },
  reauth_required: { retryable: false, message: 'The provider no longer accepts this connection. Reconnect it.' },
  insufficient_scope: { retryable: false, message: 'The connection wasn’t granted the permission this action needs. Reconnect it.' },
  forbidden: { retryable: false, message: 'The provider refused this action for the connected account.' },
  not_found: { retryable: false, message: 'The provider couldn’t find what this action refers to.' },
  conflict: { retryable: false, message: 'The provider reported a conflict with existing data.' },
  rate_limited: { retryable: true, message: 'The provider’s rate limit was reached. Try again shortly.' },
  timeout: { retryable: true, message: 'The provider didn’t respond in time.' },
  unavailable: { retryable: true, message: 'The provider is temporarily unavailable.' },
  provider_error: { retryable: false, message: 'The provider returned an error.' },
  outcome_unknown: {
    retryable: false,
    message: 'The request may or may not have reached the provider, so it wasn’t sent again. Check the provider before retrying.',
  },
  action_disabled: { retryable: false, message: 'This action is turned off for this connection.' },
  denied_by_policy: { retryable: false, message: 'A workspace policy blocks this action.' },
}

/** Stored in tool_executions.error and returned to callers; contains no secrets. */
export interface NormalizedError {
  code: IntegrationErrorCode
  message: string
  retryable: boolean
  httpStatus?: number
  providerCode?: string
  correlationId?: string
  retryAfterMs?: number
}

const MAX_MESSAGE = 500

/** Provider text made safe to store and show: credentials removed, length capped. */
export function safeProviderText(value: unknown, max = MAX_MESSAGE): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = redactString(value).replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

export class IntegrationError extends Error {
  override name = 'IntegrationError'
  readonly code: IntegrationErrorCode
  readonly retryable: boolean
  readonly httpStatus?: number
  readonly providerCode?: string
  readonly correlationId?: string
  readonly retryAfterMs?: number
  /**
   * False only when the request certainly did not reach the provider (refused
   * by a rate limit, or the connection failed before sending). Decides whether
   * a non-idempotent action may be retried.
   */
  readonly mayHaveReachedProvider: boolean

  constructor(
    code: IntegrationErrorCode,
    options: {
      message?: string
      retryable?: boolean
      httpStatus?: number
      providerCode?: string
      correlationId?: string
      retryAfterMs?: number
      mayHaveReachedProvider?: boolean
    } = {},
  ) {
    super(safeProviderText(options.message) ?? ERROR_CODE_INFO[code].message)
    this.code = code
    this.retryable = options.retryable ?? ERROR_CODE_INFO[code].retryable
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus
    const providerCode = safeProviderText(options.providerCode, 100)
    if (providerCode) this.providerCode = providerCode
    const correlationId = safeProviderText(options.correlationId, 100)
    if (correlationId) this.correlationId = correlationId
    if (options.retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.round(options.retryAfterMs))
    this.mayHaveReachedProvider = options.mayHaveReachedProvider ?? code !== 'rate_limited'
  }

  toJSON(): NormalizedError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      ...(this.providerCode === undefined ? {} : { providerCode: this.providerCode }),
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    }
  }
}

export function isIntegrationError(error: unknown): error is IntegrationError {
  return error instanceof IntegrationError
}

/** Codes after which the connection itself needs attention (reconnect). */
export function needsReconnect(code: IntegrationErrorCode): boolean {
  return code === 'reauth_required' || code === 'insufficient_scope'
}

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

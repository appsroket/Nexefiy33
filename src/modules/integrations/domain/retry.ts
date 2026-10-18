// When to retry a failed provider call, and how long to wait. Pure.
//
// A retry happens only when the failure is transient, attempts remain, the
// wait fits the policy, and repeating the call cannot duplicate an effect:
// a non-idempotent action is retried only when the provider certainly didn't
// receive it (a 429 refusal or a connection that failed before sending).

import type { IntegrationError } from './errors'
import type { IdempotencyStrategy, RetryPolicy } from './types'

export function backoffDelayMs(policy: RetryPolicy, failedAttempts: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, failedAttempts - 1))
}

export interface RetryDecision {
  retry: boolean
  delayMs: number
  reason: string
}

export function decideRetry(
  error: IntegrationError,
  failedAttempts: number,
  policy: RetryPolicy,
  idempotency: IdempotencyStrategy,
): RetryDecision {
  if (!error.retryable) return { retry: false, delayMs: 0, reason: 'not retryable' }
  if (failedAttempts >= policy.maxAttempts) return { retry: false, delayMs: 0, reason: 'attempts exhausted' }
  if (idempotency.kind === 'not_idempotent' && error.mayHaveReachedProvider) {
    return { retry: false, delayMs: 0, reason: 'may have reached the provider; not idempotent' }
  }
  const delayMs = Math.max(backoffDelayMs(policy, failedAttempts), error.retryAfterMs ?? 0)
  if (delayMs > policy.maxDelayMs) return { retry: false, delayMs: 0, reason: 'provider asked to wait longer than the policy allows' }
  return { retry: true, delayMs, reason: 'transient failure' }
}

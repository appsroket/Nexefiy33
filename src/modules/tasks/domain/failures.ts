// Failure classification and bounded retries for employee tasks.
//
// Every way a task can stop is one of four classes, and the class decides
// what happens next:
//   transient   — the provider or our server had a problem that may pass
//                 (rate limit, overload, timeout, lost worker). Retried as a
//                 new attempt from the last checkpoint, with backoff, up to
//                 the task's max_attempts.
//   permanent   — retrying can't help (bad configuration, missing key,
//                 invalid request, the employee is no longer active).
//   limit       — the task hit one of its limits (steps, tool calls, time,
//                 cost, monthly budget). Never retried: limits are the point.
//   task        — the work itself didn't succeed (the model declined, the
//                 employee couldn't complete it, or verification failed).
//                 Not retried automatically; a person decides.
// Tool failures inside a task are not task failures: they go back to the
// model as error results, and verification reports them.

export const FAILURE_CLASSES = ['transient', 'permanent', 'limit', 'task'] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

export interface TaskFailure {
  code: string
  class: FailureClass
  message: string
}

const MODEL_CODES: Record<string, FailureClass> = {
  rate_limited: 'transient',
  overloaded: 'transient',
  timeout: 'transient',
  unavailable: 'transient',
  not_configured: 'permanent',
  auth: 'permanent',
  invalid_request: 'permanent',
  invalid_output: 'permanent',
  refused: 'task',
}

export function classifyModelFailure(code: string): FailureClass {
  return MODEL_CODES[code] ?? 'permanent'
}

/** Retries of one model call within a step (before the attempt fails). */
export const MODEL_CALL_RETRIES = 2
export const MODEL_RETRY_DELAYS_MS = [2_000, 8_000] as const

/** Delay before the next attempt of a task after a transient failure. */
export function attemptBackoffMs(failedAttemptNumber: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, failedAttemptNumber - 1), 10 * 60_000)
}

export type RetryDecision = { retry: true; delayMs: number } | { retry: false }

export function decideTaskRetry(failure: TaskFailure, attemptNumber: number, maxAttempts: number): RetryDecision {
  if (failure.class !== 'transient' || attemptNumber >= maxAttempts) return { retry: false }
  return { retry: true, delayMs: attemptBackoffMs(attemptNumber) }
}

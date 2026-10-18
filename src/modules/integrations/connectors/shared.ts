// Small helpers shared by connectors. Pure.

import { z } from 'zod'

import type { RetryPolicy } from '../domain/types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringField(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

/** Seconds from now as an ISO timestamp, or undefined for a missing/invalid value. */
export function expiresAtFrom(expiresIn: unknown, now = Date.now()): string | undefined {
  const seconds = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(now + seconds * 1000).toISOString()
}

export function splitScopes(value: unknown, separator: RegExp = /[\s,]+/): string[] {
  if (Array.isArray(value)) return value.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
  if (typeof value !== 'string') return []
  return value.split(separator).filter(Boolean)
}

/** Reads: transient failures retried with short backoff. */
export const READ_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 }
/** Writes: same bounds; the framework still refuses to resend a non-idempotent write that may have arrived. */
export const WRITE_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 5_000 }

/** Trimmed text with a length range. */
export function text(min: number, max: number) {
  return z.string().trim().min(min).max(max)
}

/** Optional trimmed text; empty strings become undefined. */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined))
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

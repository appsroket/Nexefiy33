// Value-format validators shared by the server and public environment modules.
// Safe to import from browser code: contains no values and no Node-only APIs.
// Validators return booleans only so that error messages can never echo a value.

export type Validator = (value: string) => boolean

export const startsWithAny =
  (...prefixes: string[]): Validator =>
  (value) =>
    prefixes.some((prefix) => value.startsWith(prefix) && value.length > prefix.length)

export const minLength =
  (length: number): Validator =>
  (value) =>
    value.length >= length

export const matches =
  (pattern: RegExp): Validator =>
  (value) =>
    pattern.test(value)

export const oneOf =
  (...options: string[]): Validator =>
  (value) =>
    options.includes(value)

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** An absolute http(s) URL. Plain http is accepted only for local hosts. */
export const httpUrl: Validator = (value) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && (LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost'))
}

/** Decodes the payload of a JWT without verifying it. Returns null if malformed. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const json = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8')
    const payload: unknown = JSON.parse(json)
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A legacy Supabase JWT API key carrying the given role claim. */
export const supabaseLegacyJwt =
  (role: 'anon' | 'service_role'): Validator =>
  (value) =>
    decodeJwtPayload(value)?.role === role

/** `Name <user@example.com>` or `user@example.com`. */
export const emailSender: Validator = matches(/^(?:[^<>@\r\n]*<\s*)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+(?:\s*>)?$/)

/**
 * Patterns that identify a secret credential. Used to refuse secrets placed in
 * `NEXT_PUBLIC_*` variables, which Next.js inlines into the browser bundle.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sb_secret_/,
  /^sk_(live|test)_/,
  /^rk_(live|test)_/,
  /^whsec_/,
  /^sk-ant-/,
  /^sk-/,
  /^tr_(dev|prod|stg|preview)_/,
  /^re_[A-Za-z0-9_]{8,}/,
  /^GOCSPX-/,
  /^xox[abpr]-/,
]

export function looksLikeSecretValue(value: string): boolean {
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return true
  return decodeJwtPayload(value)?.role === 'service_role'
}

const SECRET_NAME_PATTERN = /SECRET|SERVICE_ROLE|PASSWORD|PRIVATE_KEY/i

export function looksLikeSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name)
}

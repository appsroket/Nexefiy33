// Redaction applied before anything is logged, stored in task events, or sent
// to error monitoring. It is a safety net, not permission to log raw payloads:
// log identifiers and event types, never request bodies, headers, or tokens.

const REDACTED = '[REDACTED]'
const MAX_DEPTH = 8

/** Object keys whose values are always removed, whatever they contain. */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|apikey|api[-_]?key|password|passwd|secret|client[-_]?secret|signing[-_]?secret|webhook[-_]?secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|private[-_]?key|credentials?|encrypted[-_]?credentials?|x-hub-signature(-256)?|x-slack-signature|stripe-signature|x-hubspot-signature(-v3)?|code[-_]?verifier)$/i

/** Credential shapes removed from free text (error messages, URLs, provider responses). */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  [/\bsb_secret_[A-Za-z0-9_-]+/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]+/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9+/=]+/g, REDACTED],
  [/\bre_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\btr_(dev|prod|stg|preview)_[A-Za-z0-9]+/g, REDACTED],
  [/\bGOCSPX-[A-Za-z0-9_-]+/g, REDACTED],
  [/\bya29\.[A-Za-z0-9._-]+/g, REDACTED],
  [/\b1\/\/[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[abpre]-[A-Za-z0-9-]+/g, REDACTED],
  [/\bnxf1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Secret-bearing query parameters, e.g. ?access_token=... or &code=...
  [/([?&](?:access_token|refresh_token|id_token|token|code|client_secret|api_key|apikey|key|signature)=)[^&#\s]+/gi, `$1${REDACTED}`],
]

export function redactString(value: string): string {
  let result = value
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement)
  return result
}

/** Deep copy of `value` with sensitive keys and credential-shaped strings removed. */
export function redact<T>(value: T): T {
  return walk(value, 0, new WeakSet()) as T
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[Truncated]'
  seen.add(value)

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) }
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    return walk(Object.fromEntries(value.entries()), depth + 1, seen)
  }
  if (value instanceof Map) {
    return walk(Object.fromEntries(value.entries()), depth + 1, seen)
  }
  if (ArrayBuffer.isView(value)) {
    return `[Binary ${value.byteLength} bytes]`
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen))

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(item, depth + 1, seen)
  }
  return result
}

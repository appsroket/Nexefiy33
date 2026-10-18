import 'server-only'

/**
 * Fixed-window counter kept in this server instance's memory. It slows down
 * repeated submissions from one sender but is not shared between instances
 * and resets on deploy; a shared store replaces it in the hardening phase
 * (docs/known-limitations.md).
 */
export function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }: { limit: number; windowMs: number; maxKeys?: number }) {
  const windows = new Map<string, { start: number; count: number }>()

  return function allow(key: string, now = Date.now()): boolean {
    if (windows.size >= maxKeys) {
      for (const [candidate, window] of windows) if (now - window.start >= windowMs) windows.delete(candidate)
      // Still full of active senders: refuse rather than grow without bound.
      if (windows.size >= maxKeys && !windows.has(key)) return false
    }
    const window = windows.get(key)
    if (!window || now - window.start >= windowMs) {
      windows.set(key, { start: now, count: 1 })
      return true
    }
    if (window.count >= limit) return false
    window.count += 1
    return true
  }
}

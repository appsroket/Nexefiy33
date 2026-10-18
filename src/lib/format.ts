// Date formatting for the UI. Pure (the caller passes "now" and the time
// zone), so output is deterministic in tests and on the server.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
]

/** "in 3 hours", "2 days ago", "just now". */
export function formatRelativeTime(value: string | Date, now: Date, locale = 'en'): string {
  const diff = new Date(value).getTime() - now.getTime()
  if (Number.isNaN(diff)) return ''
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return formatter.format(Math.round(diff / ms), unit)
  }
  return 'just now'
}

/** "Oct 17, 2026, 2:05 PM" in the given time zone (the server renders UTC, the browser its local zone). */
export function formatDateTime(value: string | Date, options: { timeZone?: string; locale?: string } = {}): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(options.locale ?? 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: options.timeZone,
  }).format(date)
}

// The period an analytics page covers. Periods are UTC and end "now" (or at
// the end of a past month); evidence links carry the exact from/to so that a
// number and the rows behind it are always read over the same window.

export const ANALYTICS_PERIODS = ['7d', '30d', '90d', 'month', 'last_month'] as const
export type AnalyticsPeriodKey = (typeof ANALYTICS_PERIODS)[number]

export const ANALYTICS_PERIOD_LABELS: Record<AnalyticsPeriodKey, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  month: 'This month (UTC)',
  last_month: 'Last month (UTC)',
}

export const DEFAULT_PERIOD: AnalyticsPeriodKey = '30d'
/** The database refuses longer windows. */
export const MAX_PERIOD_DAYS = 366

export interface AnalyticsPeriod {
  key: AnalyticsPeriodKey | 'custom'
  from: Date
  to: Date
  label: string
}

const DAY = 86_400_000

function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1))
}

export function resolvePeriod(key: AnalyticsPeriodKey, now: Date): AnalyticsPeriod {
  const label = ANALYTICS_PERIOD_LABELS[key]
  switch (key) {
    case '7d':
    case '30d':
    case '90d':
      return { key, from: new Date(now.getTime() - Number.parseInt(key, 10) * DAY), to: now, label }
    case 'month':
      return { key, from: monthStart(now.getUTCFullYear(), now.getUTCMonth()), to: now, label }
    case 'last_month':
      return { key, from: monthStart(now.getUTCFullYear(), now.getUTCMonth() - 1), to: monthStart(now.getUTCFullYear(), now.getUTCMonth()), label }
  }
}

function isPeriodKey(value: unknown): value is AnalyticsPeriodKey {
  return typeof value === 'string' && (ANALYTICS_PERIODS as readonly string[]).includes(value)
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** `?period=` from a page's search params; anything unknown falls back to the default. */
export function periodFromParams(params: Record<string, string | string[] | undefined>, now: Date): AnalyticsPeriod {
  const key = first(params.period)
  return resolvePeriod(isPeriodKey(key) ? key : DEFAULT_PERIOD, now)
}

/**
 * An exact window from `?from=&to=` (ISO timestamps, as evidence links carry
 * them). Null when either is missing or malformed, the window is empty, or it
 * is longer than the database allows.
 */
export function exactPeriod(params: Record<string, string | string[] | undefined>): AnalyticsPeriod | null {
  const fromText = first(params.from)
  const toText = first(params.to)
  if (!fromText || !toText) return null
  const from = new Date(fromText)
  const to = new Date(toText)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  if (to <= from || to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY) return null
  return { key: 'custom', from, to, label: 'Custom period' }
}

export function periodDays(period: Pick<AnalyticsPeriod, 'from' | 'to'>): number {
  return (period.to.getTime() - period.from.getTime()) / DAY
}

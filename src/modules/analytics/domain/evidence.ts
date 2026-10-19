// Links from a number to the rows behind it, and reading such a link back.
// The link carries the exact window, so the evidence page lists precisely the
// rows the number counted, even if "the last 30 days" has moved on since.

import { exactPeriod, type AnalyticsPeriod } from './period'
import { FACT_SOURCES, type EvidenceGrain, type EvidenceRef, type FactSource } from './metrics'

export interface EvidenceQuery extends EvidenceRef {
  grain: EvidenceGrain
  /** Department, employee id, workflow id, provider or "provider:error_code"; absent for the organization. */
  key?: string
  period: Pick<AnalyticsPeriod, 'from' | 'to'>
  /** What the list shows, e.g. "Verified completions · Sales". */
  title?: string
  page?: number
}

export const EVIDENCE_PAGE_SIZE = 50

const EVIDENCE_GRAINS: readonly EvidenceGrain[] = ['organization', 'department', 'employee', 'workflow', 'provider', 'provider_error']
const FLAG = /^[a-z][a-z0-9_.]{0,79}$/

export function evidenceHref(query: EvidenceQuery): string {
  const params = new URLSearchParams({ source: query.source, flag: query.flag, grain: query.grain })
  if (query.key) params.set('key', query.key)
  params.set('from', query.period.from.toISOString())
  params.set('to', query.period.to.toISOString())
  if (query.title) params.set('title', query.title.slice(0, 120))
  if (query.page && query.page > 1) params.set('page', String(query.page))
  return `/app/analytics/evidence?${params.toString()}`
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** An evidence link read back from search params; null when anything is missing or malformed. */
export function parseEvidenceQuery(params: Record<string, string | string[] | undefined>): EvidenceQuery | null {
  const source = first(params.source)
  const flag = first(params.flag)
  const grain = first(params.grain) ?? 'organization'
  const key = first(params.key)
  const period = exactPeriod(params)
  if (!source || !(FACT_SOURCES as readonly string[]).includes(source)) return null
  if (!flag || !FLAG.test(flag)) return null
  if (!(EVIDENCE_GRAINS as readonly string[]).includes(grain)) return null
  if (grain !== 'organization' && (!key || key.length > 200)) return null
  if (!period) return null
  const page = Number.parseInt(first(params.page) ?? '1', 10)
  const title = first(params.title)?.slice(0, 120)
  return {
    source: source as FactSource,
    flag,
    grain: grain as EvidenceGrain,
    key: grain === 'organization' ? undefined : key,
    period: { from: period.from, to: period.to },
    title,
    page: Number.isFinite(page) && page >= 1 && page <= 1000 ? page : 1,
  }
}

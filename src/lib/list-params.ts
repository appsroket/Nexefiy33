// URL-driven list state (search, filters, sorting, paging) for tables. Pure:
// pages parse searchParams on the server, query with the result, and build
// links for sort headers and pagination. Unknown or invalid values fall back
// to defaults, so a hand-edited URL can never produce an unexpected query.

export type SearchParams = Record<string, string | string[] | undefined>
export type SortDirection = 'asc' | 'desc'

export interface ListSpec<S extends string, F extends string> {
  sortable: readonly S[]
  defaultSort: { column: S; direction: SortDirection }
  /** Allowed values per filter parameter. */
  filters?: Readonly<Record<F, readonly string[]>>
  pageSize?: number
  maxSearchLength?: number
}

export interface ListState<S extends string, F extends string> {
  q: string
  sort: { column: S; direction: SortDirection }
  filters: Partial<Record<F, string>>
  page: number
  pageSize: number
  /** Inclusive row range for Supabase `.range(from, to)`. */
  from: number
  to: number
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

export function parseListParams<S extends string, F extends string = never>(
  params: SearchParams,
  spec: ListSpec<S, F>,
): ListState<S, F> {
  const pageSize = spec.pageSize ?? 25
  const q = (first(params.q) ?? '').trim().slice(0, spec.maxSearchLength ?? 100)

  const sortParam = first(params.sort)
  const column = spec.sortable.find((candidate) => candidate === sortParam) ?? spec.defaultSort.column
  const dirParam = first(params.dir)
  const direction: SortDirection =
    dirParam === 'asc' || dirParam === 'desc'
      ? dirParam
      : column === spec.defaultSort.column
        ? spec.defaultSort.direction
        : 'asc'

  const filters: Partial<Record<F, string>> = {}
  for (const [name, allowed] of Object.entries(spec.filters ?? {}) as [F, readonly string[]][]) {
    const value = first(params[name])
    if (value !== undefined && allowed.includes(value)) filters[name] = value
  }

  const pageParam = Number.parseInt(first(params.page) ?? '', 10)
  const page = Number.isFinite(pageParam) && pageParam >= 1 && pageParam <= 10_000 ? pageParam : 1
  const from = (page - 1) * pageSize

  return { q, sort: { column, direction }, filters, page, pageSize, from, to: from + pageSize - 1 }
}

/**
 * Builds a link to the same list with some parameters changed. `null` removes
 * a parameter. Changing anything other than the page resets to page 1.
 */
export function listHref(
  pathname: string,
  current: SearchParams,
  changes: Record<string, string | number | null>,
): string {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(current)) {
    const v = first(value)
    if (v !== undefined && v !== '') next.set(key, v)
  }
  if (!('page' in changes)) next.delete('page')
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') next.delete(key)
    else next.set(key, String(value))
  }
  if (next.get('page') === '1') next.delete('page')
  const query = next.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

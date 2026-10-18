'use client'

import { Search, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useId, useRef, useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

export interface FilterOption {
  value: string
  label: string
}

export interface FilterDefinition {
  /** URL search parameter, e.g. "status". */
  param: string
  label: string
  /** Label for "no filter", e.g. "All statuses". */
  allLabel: string
  options: readonly FilterOption[]
}

const ALL = '__all__'
const SEARCH_DELAY_MS = 300

/**
 * Search box and dropdown filters that live in the URL, so filtered views can
 * be bookmarked and shared. The server page reads the same parameters with
 * parseListParams. Changing a filter resets paging.
 */
export function FilterBar({
  filters = [],
  searchLabel = 'Search',
  searchPlaceholder = 'Search…',
  showSearch = true,
  className,
}: {
  filters?: readonly FilterDefinition[]
  searchLabel?: string
  searchPlaceholder?: string
  showSearch?: boolean
  className?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const searchId = useId()

  const urlQuery = searchParams.get('q') ?? ''
  const [query, setQuery] = useState(urlQuery)
  const lastPushed = useRef(urlQuery)

  // Keep the box in sync when the URL changes elsewhere (back button, clear).
  useEffect(() => {
    if (urlQuery !== lastPushed.current) {
      lastPushed.current = urlQuery
      setQuery(urlQuery)
    }
  }, [urlQuery])

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    next.delete('page')
    const qs = next.toString()
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  // Debounce typing so each keystroke doesn't trigger a server render.
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === lastPushed.current) return
    const timer = setTimeout(() => {
      lastPushed.current = trimmed
      update({ q: trimmed || null })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- update reads the latest URL on each call
  }, [query])

  const active = Boolean(urlQuery) || filters.some((filter) => searchParams.get(filter.param))

  return (
    <div
      role="search"
      aria-busy={pending}
      className={cn('flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end', className)}
    >
      {showSearch ? (
        <div className="flex min-w-0 flex-col gap-1.5 sm:w-72">
          <Label htmlFor={searchId}>{searchLabel}</Label>
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id={searchId}
              type="search"
              value={query}
              placeholder={searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={100}
            />
          </InputGroup>
        </div>
      ) : null}

      {filters.map((filter) => (
        <FilterSelect
          key={filter.param}
          filter={filter}
          value={searchParams.get(filter.param) ?? ALL}
          onChange={(value) => update({ [filter.param]: value === ALL ? null : value })}
        />
      ))}

      <div className="flex h-8 items-center gap-2">
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              lastPushed.current = ''
              setQuery('')
              update(Object.fromEntries([['q', null], ...filters.map((filter) => [filter.param, null])]))
            }}
          >
            <X aria-hidden="true" data-icon="inline-start" />
            Clear filters
          </Button>
        ) : null}
        {pending ? <Spinner aria-label="Updating results" /> : null}
      </div>
    </div>
  )
}

function FilterSelect({
  filter,
  value,
  onChange,
}: {
  filter: FilterDefinition
  value: string
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5 sm:w-48">
      <Label htmlFor={id}>{filter.label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{filter.allLabel}</SelectItem>
          {filter.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

'use client'

import { useSyncExternalStore } from 'react'

import { formatDateTime } from '@/lib/format'

const subscribe = () => () => {}

/**
 * A timestamp in the viewer's own time zone. The server doesn't know that
 * zone, so it renders UTC (labelled) and the browser switches to local time
 * after hydration, without a hydration mismatch.
 */
export function DateTime({ value, className }: { value: string; className?: string }) {
  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
  const text = isClient ? formatDateTime(value) : `${formatDateTime(value, { timeZone: 'UTC' })} UTC`
  return (
    <time dateTime={value} className={className}>
      {text}
    </time>
  )
}

'use client'

import Link from 'next/link'
import { useEffect } from 'react'

import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'

/** Shared body of the error.tsx boundaries: plain message, retry, and a way out. */
export function RouteError({
  error,
  retry,
  headingLevel,
  home = { href: '/app', label: 'Go to overview' },
}: {
  error: unknown
  retry: () => void
  headingLevel: 1 | 2
  /** Where "a way out" leads: the app overview by default. */
  home?: { href: string; label: string }
}) {
  // Production errors from Server Components carry only a digest; never show raw messages.
  const digest = error instanceof Error && 'digest' in error && error.digest ? String(error.digest) : undefined

  useEffect(() => {
    console.error('Route error', digest ?? '')
  }, [digest])

  return (
    <ErrorState
      headingLevel={headingLevel}
      title="This page couldn’t be loaded"
      reference={digest}
      actions={
        <>
          <Button onClick={() => retry()}>Try again</Button>
          <Button variant="outline" asChild>
            <Link href={home.href}>{home.label}</Link>
          </Button>
        </>
      }
    />
  )
}

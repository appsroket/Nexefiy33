'use client'

// Last-resort boundary for errors in the root layout itself. It replaces the
// whole document, so it must render <html> and <body> and import its styles.

import { useEffect } from 'react'

import './globals.css'

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && 'digest' in error ? String(error.digest) : undefined

  useEffect(() => {
    // Message only; the server log holds details under the same digest.
    console.error('Application error', digest ?? '')
  }, [digest])

  return (
    <html lang="en">
      <body className="flex min-h-svh items-center justify-center bg-background p-6 font-sans text-foreground">
        <title>Something went wrong · Nexefiy</title>
        <main id="main-content" className="flex max-w-md flex-col items-center gap-4 text-center" role="alert">
          <h1 className="text-xl font-semibold">Nexefiy couldn’t load</h1>
          <p className="text-sm text-muted-foreground">
            Something went wrong on our side. Your data is safe. Please try again in a moment.
          </p>
          {digest ? (
            <p className="text-xs text-muted-foreground">
              Reference: <code className="font-mono">{digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => retry()}
            className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}

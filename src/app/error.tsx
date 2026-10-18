'use client'

// Catches errors in a layout below the root: the public website's layout or
// the application shell (for example when workspace data can't be loaded).

import { RouteError } from '@/components/route-error'

export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <main id="main-content" className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <RouteError error={error} retry={retry} headingLevel={1} home={{ href: '/', label: 'Go to the home page' }} />
      </div>
    </main>
  )
}

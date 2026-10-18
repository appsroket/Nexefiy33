'use client'

// Errors inside a page keep the sidebar and header usable.

import { RouteError } from '@/components/route-error'

export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} headingLevel={1} />
}

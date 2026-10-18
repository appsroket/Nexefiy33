import { FileQuestion } from 'lucide-react'
import Link from 'next/link'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

// Rendered inside the shell, so navigation stays available on a 404.
export default function AppNotFound() {
  return (
    <>
      <title>Page not found · Nexefiy</title>
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        icon={FileQuestion}
        title="We couldn’t find that page"
        description="The link may be out of date, or the page may have moved. Use the navigation to find what you need."
        action={
          <Button asChild>
            <Link href="/app">Go to overview</Link>
          </Button>
        }
      />
    </>
  )
}

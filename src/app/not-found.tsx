import { FileQuestion } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { Container } from '@/modules/marketing/ui/layout-primitives'
import { SiteFooter, SiteHeader } from '@/modules/marketing/ui/site-chrome'

export const metadata: Metadata = { title: 'Page not found' }

// Unknown addresses outside the application. Inside /app, app/app/not-found.tsx
// renders a 404 within the workspace frame instead.
export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="flex flex-1 items-center outline-none">
        <Container className="flex max-w-lg flex-col gap-4 py-16">
          <h1 className="sr-only">Page not found</h1>
          <EmptyState
            icon={FileQuestion}
            title="We couldn’t find that page"
            description="The link may be out of date, or the page may have moved."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild>
                  <Link href="/">Go to the home page</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href={PUBLIC_PAGES.contact.path}>Contact us</Link>
                </Button>
              </div>
            }
          />
        </Container>
      </main>
      <SiteFooter />
    </div>
  )
}

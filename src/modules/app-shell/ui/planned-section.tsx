import { Construction } from 'lucide-react'
import Link from 'next/link'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

import { getNavItem } from '../domain/navigation'
import { NAV_ICONS } from './nav-icons'

/**
 * Page for a navigation section whose feature is not built yet. It says so
 * plainly; it never shows sample data or controls that do nothing.
 */
export function PlannedSection({ href }: { href: string }) {
  const item = getNavItem(href)
  const Icon = NAV_ICONS[item.icon]
  return (
    <>
      <PageHeader title={item.title} description={item.description} />
      <EmptyState
        icon={Icon ?? Construction}
        title="Not available yet"
        description={`${item.title} is being built and isn’t available in this version. Nothing here is active, and no data is collected for it.`}
        action={
          <Button variant="outline" asChild>
            <Link href="/app">Back to overview</Link>
          </Button>
        }
      />
    </>
  )
}

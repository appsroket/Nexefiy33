'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

const TABS = [
  { href: '/app/knowledge', label: 'Overview', match: (path: string) => path === '/app/knowledge' },
  { href: '/app/knowledge/profile', label: 'Company profile', match: (path: string) => path === '/app/knowledge/profile' },
  { href: '/app/knowledge/context/products', label: 'Business context', match: (path: string) => path.startsWith('/app/knowledge/context') },
  { href: '/app/knowledge/documents', label: 'Documents', match: (path: string) => path === '/app/knowledge/documents' },
  { href: '/app/knowledge/search', label: 'Test search', match: (path: string) => path === '/app/knowledge/search' },
] as const

/** Sub-navigation for the knowledge section. */
export function KnowledgeTabs() {
  const pathname = usePathname()
  return (
    <nav aria-label="Knowledge sections" className="overflow-x-auto border-b">
      <ul className="-mb-px flex gap-4 whitespace-nowrap">
        {TABS.map((tab) => {
          const current = tab.match(pathname)
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'inline-flex h-10 items-center border-b-2 px-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  current ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

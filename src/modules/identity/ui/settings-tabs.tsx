'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

const TABS = [
  { href: '/app/settings', label: 'General' },
  { href: '/app/settings/members', label: 'Members' },
] as const

/** Sub-navigation for workspace settings. */
export function SettingsTabs() {
  const pathname = usePathname()
  return (
    <nav aria-label="Settings sections" className="border-b">
      <ul className="-mb-px flex gap-4">
        {TABS.map((tab) => {
          const current = pathname === tab.href
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

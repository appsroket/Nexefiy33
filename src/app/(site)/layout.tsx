import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { getServerEnv } from '@/lib/env/server'
import { SiteFooter, SiteHeader, StatusBanner } from '@/modules/marketing/ui/site-chrome'

// Public pages are indexed only in production, so preview deployments never
// compete with the real site in search results.
export function generateMetadata(): Metadata {
  return getServerEnv().appEnv === 'production'
    ? { robots: { index: true, follow: true } }
    : { robots: { index: false, follow: false } }
}

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <StatusBanner />
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter />
    </div>
  )
}

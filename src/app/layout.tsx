import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import type { ReactNode } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { getServerEnv } from '@/lib/env/server'
import { cn } from '@/lib/utils'

import './globals.css'

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

// Not indexed unless a layout below says otherwise: the public website opts in
// (in production only); the signed-in application never does.
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(getServerEnv().core.appUrl),
    title: { default: 'Nexefiy', template: '%s · Nexefiy' },
    description: 'Configure AI employees, connect your business apps, and supervise their work with approvals.',
    applicationName: 'Nexefiy',
    robots: { index: false, follow: false },
  }
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn('font-sans', sans.variable, mono.variable)}>
      <body className="min-h-svh">
        <a
          href="#main-content"
          className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:ring-3 focus:ring-ring/50"
        >
          Skip to main content
        </a>
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
      </body>
    </html>
  )
}

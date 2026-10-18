// Header, footer and the product-status banner for the public website.

import { Info } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'

import { EARLY_ACCESS_HREF, FOOTER_NAV, PUBLIC_PAGES } from '../domain/site'
import { Container, Logo } from './layout-primitives'
import { DesktopNav, MobileNav } from './site-nav'

export function StatusBanner() {
  return (
    <div className="border-b bg-muted/60 text-sm">
      <Container className="flex items-start gap-2 py-2 sm:items-center">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info sm:mt-0" />
        <p className="text-pretty">
          Nexefiy is in early development: accounts and workspaces work, AI employees don’t yet.{' '}
          <Link href="/#whats-built" className="font-medium underline underline-offset-4">
            See what’s built and what’s planned
          </Link>
        </p>
      </Container>
    </div>
  )
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <Container className="flex h-16 items-center gap-4">
        <Link href="/" className="rounded-md" aria-label="Nexefiy home">
          <Logo className="text-lg" />
        </Link>
        <div className="ml-auto flex items-center gap-2 xl:ml-6 xl:flex-1">
          <DesktopNav />
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            <Button asChild variant="ghost" size="lg">
              <Link href={PUBLIC_PAGES.signIn.path}>Sign in</Link>
            </Button>
            <Button asChild size="lg">
              <Link href={EARLY_ACCESS_HREF}>Get early access</Link>
            </Button>
          </div>
          <MobileNav />
        </div>
      </Container>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t bg-muted/30">
      <Container className="grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="max-w-xs text-sm text-pretty text-muted-foreground">
            Supervised AI employees for small and mid-sized businesses. In development.
          </p>
        </div>
        {FOOTER_NAV.map((group) => (
          <nav key={group.title} aria-label={group.title}>
            <h2 className="text-sm font-semibold">{group.title}</h2>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {group.links.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-muted-foreground hover:text-foreground hover:underline">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </Container>
      <Container className="border-t py-6 text-xs text-muted-foreground">
        <p>
          © {new Date().getFullYear()} Nexefiy. The legal documents linked above are drafts awaiting legal review and are
          not in effect.
        </p>
      </Container>
    </footer>
  )
}

'use client'

// Header navigation: inline links on wide screens, a slide-over menu on small
// ones. The current page is marked with aria-current.

import { Menu } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

import { EARLY_ACCESS_HREF, HEADER_NAV, isSiteLinkActive, PUBLIC_PAGES } from '../domain/site'

export function DesktopNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className="hidden xl:block">
      <ul className="flex items-center gap-1">
        {HEADER_NAV.map((item) => {
          const active = isSiteLinkActive(item.href, pathname)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                  active && 'text-foreground',
                )}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function MobileNav() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="xl:hidden" aria-label="Open menu">
          <Menu aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full max-w-xs">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription className="sr-only">Pages on the Nexefiy website.</SheetDescription>
        </SheetHeader>
        <nav aria-label="Main" className="flex flex-col gap-6 px-4 pb-6">
          <ul className="flex flex-col gap-1">
            {HEADER_NAV.map((item) => {
              const active = isSiteLinkActive(item.href, pathname)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'block rounded-md px-3 py-2.5 text-base font-medium hover:bg-muted',
                      active && 'bg-muted',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-col gap-2 border-t pt-6">
            <Button asChild size="lg" className="h-10">
              <Link href={EARLY_ACCESS_HREF} onClick={() => setOpen(false)}>
                Get early access
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="h-10">
              <Link href={PUBLIC_PAGES.signIn.path} onClick={() => setOpen(false)}>
                Sign in
              </Link>
            </Button>
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  )
}

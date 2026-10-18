'use client'

import { Bell, ClipboardCheck } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { formatRelativeTime } from '@/lib/format'

import type { ShellNotification } from '../server/shell-context'

/**
 * Bell with a count of items that need the user's attention. Today that is
 * pending approval requests the user's role can decide, loaded under RLS.
 */
export function NotificationsMenu({
  signedIn,
  items,
  total,
}: {
  signedIn: boolean
  items: readonly ShellNotification[]
  total: number
}) {
  const [open, setOpen] = useState(false)
  const label = total > 0 ? `Notifications, ${total} waiting for you` : 'Notifications'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={label}>
          <Bell aria-hidden="true" />
          {total > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[0.6rem] font-semibold text-white tabular-nums"
            >
              {total > 99 ? '99+' : total}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <PopoverHeader className="border-b px-4 py-3">
          <PopoverTitle>Notifications</PopoverTitle>
          <PopoverDescription className="text-xs">
            {total > 0 ? `${total} ${total === 1 ? 'request needs' : 'requests need'} your approval` : 'Requests that need your attention appear here.'}
          </PopoverDescription>
        </PopoverHeader>
        {!signedIn ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Sign in to see notifications.</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">You’re all caught up.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex gap-3 px-4 py-2.5 text-sm outline-none hover:bg-muted focus-visible:bg-muted"
                >
                  <ClipboardCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="line-clamp-2">{item.title}</span>
                    <span className="text-xs text-muted-foreground">
                      Expires {formatRelativeTime(item.expiresAt, new Date())}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {signedIn ? (
          <div className="border-t p-2">
            <Button variant="ghost" size="sm" className="w-full" asChild>
              <Link href="/app/approvals" onClick={() => setOpen(false)}>
                View all approvals
              </Link>
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

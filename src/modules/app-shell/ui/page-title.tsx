'use client'

import { usePathname } from 'next/navigation'

import { findNavItem } from '../domain/navigation'

/** "Workspace › Section" in the header, so the current location is always visible. */
export function PageTitle({ workspaceName }: { workspaceName: string | null }) {
  const pathname = usePathname()
  const item = findNavItem(pathname)
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-sm">
      {workspaceName ? (
        <span className={item ? 'hidden truncate text-muted-foreground sm:inline' : 'truncate font-medium'}>
          {workspaceName}
        </span>
      ) : null}
      {workspaceName && item ? (
        <span aria-hidden="true" className="hidden text-muted-foreground sm:inline">
          /
        </span>
      ) : null}
      {item ? <span className="truncate font-medium">{item.title}</span> : null}
    </p>
  )
}

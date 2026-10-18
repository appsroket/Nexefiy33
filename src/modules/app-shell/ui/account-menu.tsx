'use client'

import { LogOut, Settings, UserRound } from 'lucide-react'
import Link from 'next/link'
import { useTransition } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'

import { initials, roleLabel, type WorkspaceMembership } from '../domain/workspace'
import { signOut } from '../server/actions'
import type { ShellUser } from '../server/shell-context'

/** The signed-in person: who they are, their role here, and sign out. */
export function AccountMenu({
  user,
  activeWorkspace,
  preview = false,
}: {
  user: ShellUser | null
  activeWorkspace: WorkspaceMembership | null
  /** Component gallery only: render without performing real actions. */
  preview?: boolean
}) {
  const [pending, startTransition] = useTransition()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={user ? `Account: ${user.displayName}` : 'Account'}>
          <Avatar size="sm">
            {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
            <AvatarFallback className="text-[0.65rem]">
              {user ? initials(user.displayName) : <UserRound aria-hidden="true" className="size-3.5" />}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {user ? (
          <>
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate font-medium text-foreground">{user.displayName}</span>
              {user.email && user.email !== user.displayName ? (
                <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
              ) : null}
            </DropdownMenuLabel>
            {activeWorkspace ? (
              <p className="px-2 pb-1.5 text-xs text-muted-foreground">
                {roleLabel(activeWorkspace.role)} in {activeWorkspace.name}
              </p>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild disabled={preview}>
              <Link href="/app/account">
                <UserRound aria-hidden="true" />
                Your account
              </Link>
            </DropdownMenuItem>
            {activeWorkspace ? (
              <DropdownMenuItem asChild disabled={preview}>
                <Link href="/app/settings">
                  <Settings aria-hidden="true" />
                  Workspace settings
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={pending || preview}
              onSelect={(event) => {
                event.preventDefault()
                startTransition(() => signOut())
              }}
            >
              {pending ? <Spinner aria-hidden="true" /> : <LogOut aria-hidden="true" />}
              {pending ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuLabel>Not signed in</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link href="/sign-in">Sign in</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

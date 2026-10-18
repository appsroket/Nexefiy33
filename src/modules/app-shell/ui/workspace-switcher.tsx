'use client'

import { Building2, Check, ChevronsUpDown, Plus } from 'lucide-react'
import Link from 'next/link'
import { useState, useTransition } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'

import { initials, roleLabel, type WorkspaceMembership } from '../domain/workspace'
import { switchWorkspace } from '../server/actions'

/**
 * Shows the active workspace and lets members of several workspaces switch.
 * The list comes from the server (RLS-filtered memberships); switching is
 * re-validated by the switchWorkspace Server Action.
 */
export function WorkspaceSwitcher({
  signedIn,
  workspaces,
  active,
}: {
  signedIn: boolean
  workspaces: readonly WorkspaceMembership[]
  active: WorkspaceMembership | null
}) {
  const { isMobile } = useSidebar()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function choose(workspace: WorkspaceMembership) {
    if (workspace.organizationId === active?.organizationId) return
    setError(null)
    startTransition(async () => {
      const result = await switchWorkspace(workspace.organizationId)
      if (result.status === 'error') setError(result.message)
    })
  }

  const title = active?.name ?? (signedIn ? 'No workspace' : 'Nexefiy')
  const subtitle = active ? roleLabel(active.role) : signedIn ? 'Not a member yet' : 'Not signed in'

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={`Workspace: ${title}. Change workspace`}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span
                aria-hidden="true"
                className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground"
              >
                {active ? initials(active.name) : <Building2 className="size-4" />}
              </span>
              <span className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{title}</span>
                <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
              </span>
              {pending ? (
                <Spinner className="ml-auto" aria-label="Switching workspace" />
              ) : (
                <ChevronsUpDown aria-hidden="true" className="ml-auto" />
              )}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
            {workspaces.length > 0 ? (
              <DropdownMenuGroup>
                {workspaces.map((workspace) => {
                  const selected = workspace.organizationId === active?.organizationId
                  return (
                    <DropdownMenuItem
                      key={workspace.organizationId}
                      onSelect={() => choose(workspace)}
                      aria-current={selected ? 'true' : undefined}
                      className="gap-2"
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-6 items-center justify-center rounded-md border text-[0.65rem] font-semibold"
                      >
                        {initials(workspace.name)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{workspace.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{roleLabel(workspace.role)}</span>
                      </span>
                      {selected ? (
                        <>
                          <Check aria-hidden="true" />
                          <span className="sr-only">(current)</span>
                        </>
                      ) : null}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuGroup>
            ) : (
              <>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  {signedIn
                    ? 'You’re not a member of any workspace yet. Create one, or open an invitation link you received.'
                    : 'Sign in to see your workspaces.'}
                </p>
              </>
            )}
            {signedIn ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="gap-2">
                  <Link href="/app/workspaces/new">
                    <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-md border">
                      <Plus className="size-3.5" />
                    </span>
                    Create a workspace
                  </Link>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <p role="status" aria-live="polite" className="px-2 text-xs text-destructive empty:hidden">
          {error}
        </p>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

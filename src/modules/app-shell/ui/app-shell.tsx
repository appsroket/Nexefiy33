// The authenticated application frame: sidebar, header, and main content.
// A Server Component: it loads the shell context once and hands plain data to
// the small client components that need interactivity.

import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

import { getShellContext } from '../server/shell-context'
import { AccountMenu } from './account-menu'
import { AppSidebar } from './app-sidebar'
import { CommandMenu } from './command-menu'
import { NotificationsMenu } from './notifications-menu'
import { PageTitle } from './page-title'
import { WorkspaceSwitcher } from './workspace-switcher'

/** Cookie written by the shadcn sidebar when it is collapsed or expanded. */
const SIDEBAR_COOKIE = 'sidebar_state'

export async function AppShell({ children }: { children: ReactNode }) {
  const [context, cookieStore] = await Promise.all([getShellContext(), cookies()])
  const signedIn = context.status === 'signed_in'
  const user = signedIn ? context.user : null
  const workspaces = signedIn ? context.workspaces : []
  const activeWorkspace = signedIn ? context.activeWorkspace : null
  const notifications = signedIn ? context.notifications : { items: [], total: 0 }

  return (
    <SidebarProvider defaultOpen={cookieStore.get(SIDEBAR_COOKIE)?.value !== 'false'}>
      <AppSidebar header={<WorkspaceSwitcher signedIn={signedIn} workspaces={workspaces} active={activeWorkspace} />} />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
          <PageTitle workspaceName={activeWorkspace?.name ?? null} />
          <div className="ml-auto flex items-center gap-1">
            <CommandMenu />
            <NotificationsMenu signedIn={signedIn} items={notifications.items} total={notifications.total} />
            <AccountMenu user={user} activeWorkspace={activeWorkspace} />
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1 px-4 py-6 outline-none md:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            {children}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

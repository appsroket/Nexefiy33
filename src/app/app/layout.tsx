import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { AppShell } from '@/modules/app-shell/ui/app-shell'

export default async function AppLayout({ children }: { children: ReactNode }) {
  // The proxy already redirects signed-out requests; this is the backstop for
  // a session that ends between the proxy and rendering.
  if ((await getShellContext()).status === 'signed_out') redirect('/sign-in?error=session')
  return <AppShell>{children}</AppShell>
}

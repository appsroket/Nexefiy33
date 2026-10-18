// Pages that show workspace data call requireWorkspace() and render its
// fallback when there is no signed-in user or no workspace to show.

import { Building2, LogIn } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

import type { WorkspaceMembership } from '../domain/workspace'
import type { ShellContext, ShellUser } from '../server/shell-context'

export type WorkspaceGate =
  | { ok: true; user: ShellUser; workspace: WorkspaceMembership }
  | { ok: false; fallback: ReactNode }

export function requireWorkspace(context: ShellContext, what: string): WorkspaceGate {
  if (context.status === 'signed_out') {
    return {
      ok: false,
      fallback: (
        <EmptyState
          icon={LogIn}
          title="Sign in required"
          description={`Sign in to see ${what}.`}
          action={
            <Button asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
          }
        />
      ),
    }
  }
  if (!context.activeWorkspace) {
    return {
      ok: false,
      fallback: (
        <EmptyState
          icon={Building2}
          title="No workspace yet"
          description={`You’re not a member of any workspace, so there are no ${what} to show. Create a workspace, or open an invitation link you received.`}
          action={
            <Button asChild>
              <Link href="/app/workspaces/new">Create a workspace</Link>
            </Button>
          }
        />
      ),
    }
  }
  return { ok: true, user: context.user, workspace: context.activeWorkspace }
}

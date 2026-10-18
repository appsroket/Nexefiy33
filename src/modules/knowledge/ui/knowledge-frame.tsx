// Shared header, sub-navigation and workspace gate for knowledge pages.

import type { ReactNode } from 'react'

import { PageHeader } from '@/components/page-header'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import type { WorkspaceMembership } from '@/modules/app-shell/domain/workspace'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'

import { KnowledgeTabs } from './knowledge-tabs'

export type KnowledgeGate = { ok: true; workspace: WorkspaceMembership } | { ok: false; page: ReactNode }

export async function knowledgeGate(): Promise<KnowledgeGate> {
  const item = getNavItem('/app/knowledge')
  const gate = requireWorkspace(await getShellContext(), 'knowledge')
  if (gate.ok) return { ok: true, workspace: gate.workspace }
  return {
    ok: false,
    page: (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    ),
  }
}

export function KnowledgeFrame({ description, children }: { description?: string; children: ReactNode }) {
  const item = getNavItem('/app/knowledge')
  return (
    <>
      <PageHeader title={item.title} description={description ?? item.description} />
      <KnowledgeTabs />
      {children}
    </>
  )
}

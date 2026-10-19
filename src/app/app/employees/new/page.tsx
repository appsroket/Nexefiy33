import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { templateCards } from '@/modules/employees/domain/templates'
import { loadEditorOptions } from '@/modules/employees/server/queries'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { NewEmployee } from '@/modules/employees/ui/new-employee'
import { isModelConfigured } from '@/modules/models/server/provider'

export const metadata: Metadata = { title: 'New AI employee' }
// Drafting with the model can take a while.
export const maxDuration = 60

export default async function NewEmployeePage() {
  const header = (
    <>
      <div>
        <Link href="/app/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          AI employees
        </Link>
      </div>
      <PageHeader title="New AI employee" description="Describe the employee or start from a template, then review the draft before saving it." />
    </>
  )
  const gate = requireWorkspace(await getShellContext(), 'AI employees')
  if (!gate.ok) {
    return (
      <>
        {header}
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  if (!hasMinRole(workspace.role, 'operator')) {
    return (
      <>
        {header}
        <EmptyState title="Viewers can’t create employees" description="Ask an operator, admin or owner of this workspace." />
      </>
    )
  }

  const tools = listEmployeeTools()
  const options = await loadEditorOptions(workspace.organizationId)
  const templates = templateCards(tools, options.connections)


  return (
    <>
      {header}
      <NewEmployee
        organizationId={workspace.organizationId}
        templates={templates}
        tools={tools}
        connections={options.connections}
        sources={options.sources}
        skills={options.skills}
        modelConfigured={isModelConfigured()}
      />
    </>
  )
}

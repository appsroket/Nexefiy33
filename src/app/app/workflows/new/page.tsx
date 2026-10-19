import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { isModelConfigured } from '@/modules/models/server/provider'
import { WORKFLOW_TEMPLATES } from '@/modules/workflows/domain/factory'
import { NewWorkflow } from '@/modules/workflows/ui/new-workflow'

export const metadata: Metadata = { title: 'New workflow' }
// Drafting with the model (and one repair attempt) can take a while.
export const maxDuration = 120

export default async function NewWorkflowPage() {
  const header = (
    <>
      <div>
        <Link href="/app/workflows" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Workflows
        </Link>
      </div>
      <PageHeader title="New workflow" description="Describe it, start from a template, or build it yourself. It is saved as a draft; nothing runs until an admin activates it." />
    </>
  )
  const gate = requireWorkspace(await getShellContext(), 'workflows')
  if (!gate.ok) {
    return (
      <>
        {header}
        {gate.fallback}
      </>
    )
  }
  if (!hasMinRole(gate.workspace.role, 'operator')) {
    return (
      <>
        {header}
        <EmptyState title="Viewers can’t create workflows" description="Ask an operator, admin or owner of this workspace." />
      </>
    )
  }
  return (
    <>
      {header}
      <NewWorkflow
        organizationId={gate.workspace.organizationId}
        templates={WORKFLOW_TEMPLATES.map((template) => ({ key: template.key, name: template.name, summary: template.summary }))}
        modelConfigured={isModelConfigured()}
      />
    </>
  )
}

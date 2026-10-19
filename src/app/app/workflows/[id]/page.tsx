import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { randomUUID } from 'node:crypto'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { RUN_STATUS_DISPLAY, WORKFLOW_STATUS_DISPLAY } from '@/modules/workflows/domain/types'
import { getBuilderContext, getVersion, getWorkflow, listRuns } from '@/modules/workflows/server/queries'
import { RestoreVersionButton, StartRunForm, WorkflowStatusControls } from '@/modules/workflows/ui/workflow-controls'
import { WorkflowEditor } from '@/modules/workflows/ui/workflow-editor'

export const metadata: Metadata = { title: 'Workflow' }
// Activation validates on the server; starting a run advances it after the response (without an engine).
export const maxDuration = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this workflow')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Workflow" />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const workflow = await getWorkflow(workspace.organizationId, id)
  if (!workflow) notFound()
  const [context, runs, current] = await Promise.all([
    getBuilderContext(workspace.organizationId),
    listRuns(workspace.organizationId, { workflowId: id }, 25),
    workflow.currentVersionId ? getVersion(workspace.organizationId, id, workflow.currentVersionId) : Promise.resolve(null),
  ])
  const canEdit = hasMinRole(workspace.role, 'operator')
  const canActivate = hasMinRole(workspace.role, 'admin')
  const status = WORKFLOW_STATUS_DISPLAY[workflow.status]

  return (
    <>
      <div>
        <Link href="/app/workflows" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Workflows
        </Link>
      </div>
      <PageHeader
        title={workflow.name}
        description={workflow.description ?? undefined}
        actions={
          <span className="flex items-center gap-2">
            <StatusIndicator tone={status.tone} label={status.label} />
            {current ? <span className="text-sm text-muted-foreground">Active version: v{current.version}</span> : null}
          </span>
        }
      />
      <WorkflowStatusControls
        organizationId={workspace.organizationId}
        workflowId={workflow.id}
        status={workflow.status}
        everActivated={workflow.versions.length > 0}
        canOperate={canEdit}
        canAdminister={canActivate}
      />

      {workflow.status === 'active' && current && canEdit ? (
        <SectionCard title={`Run version ${current.version}`} description="Starts a run of the active version with these inputs. Each value is checked against the version’s inputs on the server.">
          <StartRunForm organizationId={workspace.organizationId} workflowId={workflow.id} inputs={current.definition.inputs} requestKey={randomUUID()} />
        </SectionCard>
      ) : null}

      <SectionCard
        title="Draft"
        description={
          workflow.status === 'draft'
            ? 'This workflow has never been activated. Build it, save it, and an admin activates it once there are no problems.'
            : 'Changes to the draft don’t affect the active version or its runs until an admin activates the draft as a new version.'
        }
      >
        <WorkflowEditor
          organizationId={workspace.organizationId}
          workflowId={workflow.id}
          initialName={workflow.name}
          initialDescription={workflow.description ?? ''}
          initialDefinition={workflow.draft}
          initialLayout={workflow.layout}
          initialLockVersion={workflow.lockVersion}
          context={context}
          canEdit={canEdit}
          canActivate={canActivate}
          archived={workflow.status === 'archived'}
          notes={workflow.generation?.notes ?? []}
          unsupported={workflow.generation?.unsupported ?? []}
        />
      </SectionCard>

      <SectionCard title="Versions" description="Activated versions never change. Restore one into the draft to roll back, then activate it as a new version.">
        {workflow.versions.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Activated</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workflow.versions.map((version) => (
                <TableRow key={version.id}>
                  <TableCell>
                    <Link href={`/app/workflows/${workflow.id}/versions/${version.id}`} className="font-medium underline-offset-4 hover:underline">
                      v{version.version}
                    </Link>
                    {version.id === workflow.currentVersionId ? <span className="ml-2 text-xs text-muted-foreground">current</span> : null}
                  </TableCell>
                  <TableCell>
                    <DateTime value={version.createdAt} />
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-muted-foreground">{version.graphSha256.slice(0, 12)}</code>
                  </TableCell>
                  <TableCell className="text-right">
                    {canEdit && workflow.status !== 'archived' ? (
                      <RestoreVersionButton organizationId={workspace.organizationId} workflowId={workflow.id} versionId={version.id} version={version.version} lockVersion={workflow.lockVersion} />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No version yet.</p>
        )}
      </SectionCard>

      <SectionCard title="Runs">
        {runs.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link href={`/app/workflows/runs/${run.id}`} className="underline-offset-4 hover:underline">
                      <DateTime value={run.queuedAt} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusIndicator tone={RUN_STATUS_DISPLAY[run.status].tone} label={RUN_STATUS_DISPLAY[run.status].label} />
                  </TableCell>
                  <TableCell>{run.version ? `v${run.version}` : '—'}</TableCell>
                  <TableCell>{run.triggerType === 'schedule' ? 'Schedule' : 'By hand'}</TableCell>
                  <TableCell className="max-w-sm truncate text-sm text-muted-foreground">{run.summary ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
      </SectionCard>
    </>
  )
}

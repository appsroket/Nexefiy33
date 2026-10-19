import { Plus, Workflow } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { hasMinRole } from '@/lib/supabase/types'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { RUN_STATUS_DISPLAY, WORKFLOW_STATUS_DISPLAY } from '@/modules/workflows/domain/types'
import { listRuns, listWorkflows } from '@/modules/workflows/server/queries'

export const metadata: Metadata = { title: 'Workflows' }

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Built by hand',
  ai_generated: 'Drafted by AI',
  rules: 'Drafted by keyword rules',
  template: 'From a template',
  imported: 'Imported',
}

export default async function WorkflowsPage() {
  const item = getNavItem('/app/workflows')
  const gate = requireWorkspace(await getShellContext(), 'workflows')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const canCreate = hasMinRole(workspace.role, 'operator')
  const [workflows, runs] = await Promise.all([listWorkflows(workspace.organizationId), listRuns(workspace.organizationId, {}, 20)])
  const newButton = canCreate ? (
    <Button asChild>
      <Link href="/app/workflows/new">
        <Plus data-icon="inline-start" aria-hidden="true" />
        New workflow
      </Link>
    </Button>
  ) : null

  return (
    <>
      <PageHeader title={item.title} description={item.description} actions={newButton} />
      <p className="max-w-2xl text-sm text-muted-foreground">
        Describe a workflow, start from a template, or build it on the canvas. Every workflow is a draft until an admin activates it: the server checks its employees, actions, connections, permissions and policies, then saves an
        unchangeable version. Each run uses exactly the version that was active when it started.
      </p>
      {workflows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Active version</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workflows.map((workflow) => {
              const status = WORKFLOW_STATUS_DISPLAY[workflow.status]
              return (
                <TableRow key={workflow.id}>
                  <TableCell>
                    <Link href={`/app/workflows/${workflow.id}`} className="font-medium underline-offset-4 hover:underline">
                      {workflow.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{SOURCE_LABELS[workflow.draftSource] ?? workflow.draftSource}</p>
                  </TableCell>
                  <TableCell>
                    <StatusIndicator tone={status.tone} label={status.label} />
                  </TableCell>
                  <TableCell>{workflow.currentVersion ? `v${workflow.currentVersion}` : '—'}</TableCell>
                  <TableCell>
                    {workflow.lastRun ? (
                      <span className="flex flex-col">
                        <span>{RUN_STATUS_DISPLAY[workflow.lastRun.status].label}</span>
                        <DateTime value={workflow.lastRun.at} className="text-xs text-muted-foreground" />
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <DateTime value={workflow.updatedAt} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          icon={Workflow}
          title="No workflows yet"
          description="A workflow combines triggers, employees, actions, conditions and approvals into a repeatable process."
          action={newButton}
        />
      )}

      {runs.length ? (
        <SectionCard title="Recent runs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link href={`/app/workflows/runs/${run.id}`} className="underline-offset-4 hover:underline">
                      {run.workflowName}
                    </Link>
                    {run.summary ? <p className="max-w-md truncate text-xs text-muted-foreground">{run.summary}</p> : null}
                  </TableCell>
                  <TableCell>
                    <StatusIndicator tone={RUN_STATUS_DISPLAY[run.status].tone} label={RUN_STATUS_DISPLAY[run.status].label} />
                  </TableCell>
                  <TableCell>{run.version ? `v${run.version}` : '—'}</TableCell>
                  <TableCell>
                    <DateTime value={run.queuedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      ) : null}
    </>
  )
}

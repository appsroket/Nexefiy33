import { ArrowLeft, CircleAlert } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { cancellationDisclosure, formatDuration } from '@/modules/tasks/domain/task-center'
import { AutoRefresh } from '@/modules/tasks/ui/task-controls'
import { FINISHED_RUN_STATUSES, RUN_STATUS_DISPLAY, STEP_STATUS_DISPLAY } from '@/modules/workflows/domain/types'
import { getBuilderContext, getRun } from '@/modules/workflows/server/queries'
import { CancelRunButton } from '@/modules/workflows/ui/workflow-controls'
import { WorkflowViewer, type RunStepView } from '@/modules/workflows/ui/workflow-viewer'

export const metadata: Metadata = { title: 'Workflow run' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  if (!UUID.test(runId)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this run')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Workflow run" />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const [run, context] = await Promise.all([getRun(workspace.organizationId, runId), getBuilderContext(workspace.organizationId)])
  if (!run) notFound()
  const finished = FINISHED_RUN_STATUSES.includes(run.status)
  const status = RUN_STATUS_DISPLAY[run.status]
  const disclosure = cancellationDisclosure(run.actions.map((action) => ({ id: action.id, toolKey: action.toolKey, risk: action.risk, status: action.status })))
  const steps: Record<string, RunStepView> = Object.fromEntries(
    run.steps.map((step) => [step.nodeId, { status: step.status, branch: step.branch, attempt: step.attempt, taskId: step.taskId, input: step.input, output: step.output, error: step.error }]),
  )
  const duration = run.startedAt && run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null

  return (
    <>
      <AutoRefresh active={!finished} />
      <div>
        <Link href={`/app/workflows/${run.workflowId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {run.workflowName}
        </Link>
      </div>
      <PageHeader title={`${run.workflowName} — run`} actions={<StatusIndicator tone={status.tone} label={status.label} />} />

      {run.summary ? (
        <Alert variant={run.status === 'succeeded' ? 'default' : finished ? 'destructive' : 'default'}>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{finished ? 'Result' : 'Status'}</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{run.summary}</AlertDescription>
        </Alert>
      ) : null}
      {finished && disclosure.done.length ? (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Changes this run made in other apps</AlertTitle>
          <AlertDescription>
            {disclosure.done.map((action) => action.toolKey).join(', ')} — carried out and not undone{run.status === 'cancelled' ? ' by cancelling' : ''}.
          </AlertDescription>
        </Alert>
      ) : null}

      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Version</dt>
        <dd>
          <Link href={`/app/workflows/${run.workflowId}/versions/${run.versionId}`} className="underline underline-offset-4">
            v{run.version ?? '?'}
          </Link>{' '}
          (runs use exactly this version)
        </dd>
        <dt className="text-muted-foreground">Started</dt>
        <dd>
          <DateTime value={run.queuedAt} /> — {run.triggerType === 'schedule' ? 'by its schedule' : 'by hand'}
        </dd>
        {run.finishedAt ? (
          <>
            <dt className="text-muted-foreground">Finished</dt>
            <dd>
              <DateTime value={run.finishedAt} />
            </dd>
          </>
        ) : run.deadlineAt ? (
          <>
            <dt className="text-muted-foreground">Time limit</dt>
            <dd>
              <DateTime value={run.deadlineAt} />
            </dd>
          </>
        ) : null}
        {duration !== null ? (
          <>
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{formatDuration(duration)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Model spend</dt>
        <dd>${(run.costMicros / 1_000_000).toFixed(4)}</dd>
        {Object.keys(run.input).length ? (
          <>
            <dt className="text-muted-foreground">Inputs</dt>
            <dd>
              <code className="text-xs break-all">{JSON.stringify(run.input)}</code>
            </dd>
          </>
        ) : null}
        {run.error?.message ? (
          <>
            <dt className="text-muted-foreground">Error</dt>
            <dd className="text-destructive">{run.error.message}</dd>
          </>
        ) : null}
      </dl>

      {!finished && hasMinRole(workspace.role, 'operator') ? <CancelRunButton runId={run.id} completedChanges={[...new Set(disclosure.done.map((action) => action.toolKey))]} inProgress={disclosure.inProgress.length} /> : null}

      <WorkflowViewer definition={run.definition} layout={run.layout} context={context} steps={steps} />

      <SectionCard title="Steps">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Step</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.steps.map((step) => (
              <TableRow key={step.nodeId}>
                <TableCell>
                  {step.label}
                  {step.error?.message ? <p className="max-w-md text-xs text-destructive">{step.error.message}</p> : null}
                </TableCell>
                <TableCell>
                  <StatusIndicator tone={STEP_STATUS_DISPLAY[step.status].tone} label={STEP_STATUS_DISPLAY[step.status].label} />
                </TableCell>
                <TableCell>{step.branch ?? '—'}</TableCell>
                <TableCell>
                  {step.taskId ? (
                    <Link href={`/app/tasks/${step.taskId}`} className="underline underline-offset-4">
                      {step.taskStatus ?? 'Open'}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <DateTime value={step.startedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>

      {run.approvals.length ? (
        <SectionCard title="Approvals">
          <ul className="flex flex-col gap-1 text-sm">
            {run.approvals.map((approval) => (
              <li key={approval.id}>
                <Link href={`/app/approvals/${approval.id}`} className="underline underline-offset-4">
                  {approval.summary}
                </Link>{' '}
                — {approval.kind === 'workflow_gate' ? 'approval step' : 'action approval'}, {approval.status}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {run.actions.length ? (
        <SectionCard title="Actions" description="Actions that changed something in another app stay done; cancelling or failing a run doesn’t undo them.">
          <ul className="flex flex-col gap-1 text-sm">
            {run.actions.map((action) => (
              <li key={action.id}>
                <code className="text-xs">{action.toolKey}</code> — {action.status}
                {action.status === 'succeeded' && action.risk !== 'read' ? ' (completed; can’t be undone from here)' : ''}
                {action.status === 'executing' ? ' (running; may still complete)' : ''}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="History">
        <ol className="flex flex-col gap-1 text-sm">
          {run.events.map((event) => (
            <li key={event.id} className={event.level === 'error' ? 'text-destructive' : event.level === 'warn' ? 'text-warning-foreground' : undefined}>
              <DateTime value={event.createdAt} className="text-xs text-muted-foreground" /> {event.message ?? event.type}
            </li>
          ))}
        </ol>
      </SectionCard>
    </>
  )
}

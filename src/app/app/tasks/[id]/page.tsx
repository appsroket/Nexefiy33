import { ArrowLeft, CircleAlert, Info, ShieldAlert } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { formatUsd } from '@/modules/models/domain/catalog'
import {
  ACTION_STATUS_LABELS,
  ACTIVE_TASK_STATUSES,
  CHECK_LABELS,
  CHECK_TONE,
  FAILURE_CLASS_LABELS,
  TASK_STATUS_DISPLAY,
  VERIFICATION_DISPLAY,
} from '@/modules/tasks/domain/labels'
import { getTask } from '@/modules/tasks/server/queries'
import { canRunTasks } from '@/modules/tasks/server/scheduling'
import { AutoRefresh, CancelTaskButton, ReplyForm } from '@/modules/tasks/ui/task-controls'

export const metadata: Metadata = { title: 'Task' }
export const maxDuration = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANCELLABLE = ['pending', 'queued', 'running', 'waiting_approval', 'blocked']

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this task')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Task" />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const task = await getTask(workspace.organizationId, id)
  if (!task) notFound()

  const status = TASK_STATUS_DISPLAY[task.status]
  const isOperator = hasMinRole(workspace.role, 'operator')
  const verification = task.result?.verification ?? null
  const totalCost = task.attempts.reduce((sum, attempt) => sum + attempt.costMicros, 0)
  const totalActive = task.attempts.reduce((sum, attempt) => sum + attempt.activeMs, 0)
  const waitingApprovals = task.actions.filter((action) => action.status === 'awaiting_approval' && action.approvalRequestId)

  return (
    <>
      <AutoRefresh active={ACTIVE_TASK_STATUSES.includes(task.status)} />
      <div>
        <Link href="/app/tasks" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Tasks
        </Link>
      </div>
      <PageHeader
        title={task.title}
        description={
          task.employeeName ? (
            <>
              Assigned to{' '}
              <Link href={`/app/employees/${task.employeeId}`} className="underline-offset-4 hover:underline">
                {task.employeeName}
              </Link>
              {task.employeeVersion ? ` (version ${task.employeeVersion})` : ''}
            </>
          ) : undefined
        }
        actions={<StatusIndicator tone={status.tone} label={status.label} />}
      />

      {task.status === 'queued' && !canRunTasks() ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>
            This task is queued, but tasks don’t run on this deployment until an AI model and the Supabase secret key are configured.
          </AlertDescription>
        </Alert>
      ) : null}

      <SectionCard title="Status" description={status.description}>
        <div className="flex flex-col gap-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Assigned</dt>
            <dd>
              <DateTime value={task.createdAt} />
            </dd>
            {task.completedAt ? (
              <>
                <dt className="text-muted-foreground">Finished</dt>
                <dd>
                  <DateTime value={task.completedAt} />
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Attempts</dt>
            <dd>
              {task.attemptCount} of {task.maxAttempts}
            </dd>
            <dt className="text-muted-foreground">Model spend</dt>
            <dd>
              {formatUsd(totalCost)} · {seconds(totalActive)} active
            </dd>
          </dl>
          {task.instructions ? <p className="max-w-3xl text-sm whitespace-pre-wrap">{task.instructions}</p> : null}
          {task.error ? (
            <Alert variant={task.error.class === 'limit' || task.error.class === 'task' ? 'default' : 'destructive'}>
              <CircleAlert aria-hidden="true" />
              <AlertDescription>
                <span className="font-medium">{FAILURE_CLASS_LABELS[task.error.class] ?? 'Error'}:</span> {task.error.message}
              </AlertDescription>
            </Alert>
          ) : null}
          {task.cancelRequested && task.status === 'running' ? <p className="text-sm text-muted-foreground">Stopping after the current step…</p> : null}
          {isOperator && CANCELLABLE.includes(task.status) && !task.cancelRequested ? <CancelTaskButton taskId={task.id} /> : null}
        </div>
      </SectionCard>

      {task.status === 'waiting_approval' && waitingApprovals.length ? (
        <SectionCard title="Waiting for approval" description="The employee continues once each action is approved or rejected. Nothing below has happened yet.">
          <ul className="flex flex-col gap-2 text-sm">
            {waitingApprovals.map((action) => (
              <li key={action.id}>
                <Link href={`/app/approvals/${action.approvalRequestId}`} className="font-medium underline-offset-4 hover:underline">
                  Review {action.toolKey}
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {task.status === 'blocked' && task.result?.escalation ? (
        <SectionCard title="The employee needs your reply" description={`Reason: ${task.result.escalation.reason}`}>
          <div className="flex flex-col gap-4">
            <p className="max-w-3xl text-sm whitespace-pre-wrap">{task.result.escalation.message}</p>
            {isOperator ? <ReplyForm taskId={task.id} /> : <p className="text-sm text-muted-foreground">An operator or admin can reply.</p>}
          </div>
        </SectionCard>
      ) : null}

      {task.result?.reply || task.result?.report ? (
        <SectionCard
          title="Result"
          description="The employee’s report. What actually happened is checked against the platform’s own records below, not taken from the report."
          action={verification ? <StatusIndicator tone={VERIFICATION_DISPLAY[verification.status].tone} label={VERIFICATION_DISPLAY[verification.status].label} /> : undefined}
        >
          <div className="flex flex-col gap-4">
            {task.result.report ? (
              <Badge variant="outline" className="w-fit">
                Employee reports: {task.result.report.status.replace('_', ' ')}
              </Badge>
            ) : null}
            <p className="max-w-3xl text-sm whitespace-pre-wrap">{task.result.report?.summary ?? task.result.reply}</p>
            {verification ? (
              <ul className="flex flex-col gap-2 text-sm">
                {verification.checks.map((check) => (
                  <li key={check.key} className="flex flex-wrap items-start gap-2">
                    <StatusIndicator tone={CHECK_TONE[check.status]} label={CHECK_LABELS[check.key]} />
                    <span className="text-muted-foreground">{check.detail}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Actions" description="Every action the employee requested, as recorded by the integration executor. The receipt is the record’s id.">
        {task.actions.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {task.actions.map((action) => (
                <TableRow key={action.id}>
                  <TableCell>
                    <code className="text-xs">{action.toolKey}</code>
                  </TableCell>
                  <TableCell>
                    <StatusIndicator
                      tone={action.status === 'succeeded' ? 'success' : ['failed', 'rejected'].includes(action.status) ? 'danger' : action.status === 'awaiting_approval' ? 'warning' : 'neutral'}
                      label={ACTION_STATUS_LABELS[action.status] ?? action.status}
                    />
                  </TableCell>
                  <TableCell className="text-sm">
                    {action.decision === 'allow' ? 'Ran without approval' : action.decision === 'require_approval' ? 'Needed approval' : 'Blocked'}
                    {action.reason ? <span className="block text-xs text-muted-foreground">{action.reason}</span> : null}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{action.id.slice(0, 8)}</code>
                  </TableCell>
                  <TableCell className="max-w-md">
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Input and result</summary>
                      <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2">{JSON.stringify(action.input, null, 2)}</pre>
                      {action.output ? <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/60 p-2">{JSON.stringify(action.output, null, 2)}</pre> : null}
                      {action.error ? <p className="mt-1 text-destructive">{action.error.message ?? action.error.code}</p> : null}
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No integration actions.</p>
        )}
      </SectionCard>

      <SectionCard title="Evidence" description="What the employee read: knowledge passages and integration results. This is untrusted data, kept for review.">
        {task.evidence.length ? (
          <ul className="flex flex-col gap-3 text-sm">
            {task.evidence.map((item) => (
              <li key={item.id} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.kind === 'knowledge_passage' ? (item.label ?? 'Passage') : 'Tool result'}</Badge>
                  <span className="font-medium">{item.title}</span>
                  {item.suspicious ? (
                    <span className="inline-flex items-center gap-1 text-xs text-warning">
                      <ShieldAlert className="size-3" aria-hidden="true" />
                      Looks like instructions (treated as data)
                    </span>
                  ) : null}
                </span>
                {item.excerpt ? <p className="line-clamp-4 max-w-3xl text-xs whitespace-pre-wrap text-muted-foreground">{item.excerpt}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No evidence recorded.</p>
        )}
      </SectionCard>

      <SectionCard title="Trace" description="Each step, as it was recorded.">
        {task.events.length ? (
          <ol className="flex flex-col gap-2 text-sm">
            {task.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-40 shrink-0 text-xs text-muted-foreground">
                  <DateTime value={event.createdAt} />
                </span>
                <code className={`text-xs ${event.level === 'error' ? 'text-destructive' : event.level === 'warn' ? 'text-warning' : 'text-muted-foreground'}`}>{event.type}</code>
                <span className="min-w-0 flex-1">{event.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        )}
      </SectionCard>

      {task.attempts.length ? (
        <SectionCard title="Attempts" description="A new attempt starts only after a failure; waiting for approval or a reply continues the same attempt.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Tool calls</TableHead>
                <TableHead>Tokens (in / out)</TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {task.attempts.map((attempt) => (
                <TableRow key={attempt.number}>
                  <TableCell>{attempt.number}</TableCell>
                  <TableCell>
                    {attempt.status}
                    {attempt.error ? <span className="block text-xs text-muted-foreground">{attempt.error.message}</span> : null}
                  </TableCell>
                  <TableCell className="text-xs">{attempt.model ?? '—'}</TableCell>
                  <TableCell>{attempt.turns}</TableCell>
                  <TableCell>{attempt.toolCalls}</TableCell>
                  <TableCell>
                    {attempt.inputTokens.toLocaleString('en')} / {attempt.outputTokens.toLocaleString('en')}
                  </TableCell>
                  <TableCell>{formatUsd(attempt.costMicros)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      ) : null}
    </>
  )
}

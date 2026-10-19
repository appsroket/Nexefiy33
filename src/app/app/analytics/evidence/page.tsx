import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { formatCount } from '@/modules/analytics/domain/calculations'
import { evidenceHref, parseEvidenceQuery, type EvidenceQuery } from '@/modules/analytics/domain/evidence'
import { METRICS } from '@/modules/analytics/domain/metrics'
import { outcomeKeyLabel } from '@/modules/analytics/domain/outcomes'
import { departmentLabel, loadEvidence, loadScopeNames, type ScopeNames } from '@/modules/analytics/server/queries'
import { formatMetric } from '@/modules/analytics/ui/metric-tile'
import { formatUsd } from '@/modules/models/domain/catalog'
import { TASK_STATUS_DISPLAY, type TaskStatus } from '@/modules/tasks/domain/labels'
import { formatDuration } from '@/modules/tasks/domain/task-center'
import { RUN_STATUS_DISPLAY, type RunStatus } from '@/modules/workflows/domain/types'

export const metadata: Metadata = { title: 'Evidence' }

type Item = Record<string, unknown>
const text = (item: Item, key: string) => (typeof item[key] === 'string' ? (item[key] as string) : null)
const num = (item: Item, key: string) => (typeof item[key] === 'number' ? (item[key] as number) : null)

function scopeLabel(query: EvidenceQuery, names: ScopeNames): string {
  switch (query.grain) {
    case 'organization':
      return 'the whole workspace'
    case 'department':
      return `the ${departmentLabel(query.key!)} department`
    case 'employee':
      return names.employees.get(query.key!)?.name ?? 'a deleted employee'
    case 'workflow':
      return names.workflows.get(query.key!) ?? 'a deleted workflow'
    case 'provider':
      return `${query.key} actions`
    case 'provider_error':
      return `${query.key!.replace(':', ' actions failing with ')}`
  }
}

/** The metrics this flag backs, so the page can say what was counted. */
function describeFlag(query: EvidenceQuery): string {
  if (query.source === 'outcome') return `Outcome records “${outcomeKeyLabel(query.flag)}”.`
  const metrics = METRICS.filter((metric) => metric.evidence?.source === query.source && metric.evidence.flag === query.flag)
  const denominators = METRICS.filter((metric) => metric.denominator?.source === query.source && metric.denominator.flag === query.flag)
  const parts = [...metrics.map((metric) => metric.method), ...denominators.map((metric) => `The rows “${metric.label}” is a share of.`)]
  return parts[0] ?? 'Rows matching this flag.'
}

export default async function EvidencePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseEvidenceQuery(await searchParams)
  const gate = requireWorkspace(await getShellContext(), 'evidence')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Evidence" />
        {gate.fallback}
      </>
    )
  }
  const back = (
    <div>
      <Link href="/app/analytics" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Analytics
      </Link>
    </div>
  )
  if (!query) {
    return (
      <>
        {back}
        <PageHeader title="Evidence" />
        <SectionCard title="This link doesn’t name a metric">
          <p className="text-sm text-muted-foreground">Open evidence from a number on an analytics page.</p>
        </SectionCard>
      </>
    )
  }
  const { workspace } = gate
  const [page, names] = await Promise.all([loadEvidence(workspace.organizationId, query), loadScopeNames(workspace.organizationId)])
  const current = query.page ?? 1
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize))
  const employeeName = (id: string | null) => (id ? (names.employees.get(id)?.name ?? 'Deleted employee') : '—')

  return (
    <>
      {back}
      <PageHeader
        title={query.title ?? 'Evidence'}
        description={
          <>
            {formatCount(page.total)} {page.total === 1 ? 'record' : 'records'} for {scopeLabel(query, names)}, {query.period.from.toISOString().slice(0, 16).replace('T', ' ')} to{' '}
            {query.period.to.toISOString().slice(0, 16).replace('T', ' ')} UTC. {describeFlag(query)}
          </>
        }
      />
      <SectionCard title="Records">
        {page.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No records.</p>
        ) : query.source === 'task' ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Employee</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Time to complete</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Model cost</TableHead>
                {num(page.items[0]!, query.flag) !== null ? <TableHead className="text-right">Value</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) => {
                const status = TASK_STATUS_DISPLAY[text(item, 'status') as TaskStatus]
                const duration = num(item, 'duration_ms')
                const value = num(item, query.flag)
                return (
                  <TableRow key={text(item, 'task_id')}>
                    <TableCell className="whitespace-normal">
                      <Link href={`/app/tasks/${text(item, 'task_id')}`} className="font-medium underline-offset-4 hover:underline">
                        {text(item, 'title')}
                      </Link>
                      {item.verified ? <span className="ml-2 text-xs text-muted-foreground">verified</span> : null}
                      {text(item, 'failure_code') ? <span className="ml-2 font-mono text-xs text-muted-foreground">{text(item, 'failure_code')}</span> : null}
                    </TableCell>
                    <TableCell>{status ? <StatusIndicator tone={status.tone} label={status.label} /> : text(item, 'status')}</TableCell>
                    <TableCell className="hidden md:table-cell">{employeeName(text(item, 'employee_id'))}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <DateTime value={text(item, 'created_at')!} />
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">{duration === null ? '—' : formatDuration(duration)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">{formatUsd(num(item, 'cost_micros') ?? 0)}</TableCell>
                    {value !== null ? (
                      <TableCell className="text-right tabular-nums">{query.flag === 'cost_micros' ? formatUsd(value) : formatMetric(query.flag.endsWith('_ms') ? 'duration' : 'count', value)}</TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : query.source === 'action' ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Error</TableHead>
                <TableHead className="hidden md:table-cell">Employee</TableHead>
                <TableHead className="hidden sm:table-cell">Requested</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) => (
                <TableRow key={text(item, 'execution_id')}>
                  <TableCell>
                    <Link href={`/app/tasks/${text(item, 'task_id')}`} className="font-mono text-xs underline-offset-4 hover:underline">
                      {text(item, 'tool_key')}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize">{text(item, 'status')?.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="hidden font-mono text-xs sm:table-cell">{text(item, 'error_code') ?? '—'}</TableCell>
                  <TableCell className="hidden md:table-cell">{text(item, 'employee_id') ? employeeName(text(item, 'employee_id')) : 'Workflow step'}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <DateTime value={text(item, 'created_at')!} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : query.source === 'run' ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Started</TableHead>
                <TableHead className="hidden text-right md:table-cell">Duration</TableHead>
                <TableHead className="hidden text-right md:table-cell">Failed steps</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Model cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) => {
                const status = RUN_STATUS_DISPLAY[text(item, 'status') as RunStatus]
                const duration = num(item, 'duration_ms')
                return (
                  <TableRow key={text(item, 'run_id')}>
                    <TableCell>
                      <Link href={`/app/workflows/runs/${text(item, 'run_id')}`} className="font-medium underline-offset-4 hover:underline">
                        {names.workflows.get(text(item, 'workflow_id') ?? '') ?? 'Workflow run'}
                      </Link>
                    </TableCell>
                    <TableCell>{status ? <StatusIndicator tone={status.tone} label={status.label} /> : text(item, 'status')}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <DateTime value={text(item, 'queued_at')!} />
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">{duration === null ? '—' : formatDuration(duration)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">{formatCount(num(item, 'steps_failed') ?? 0)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">{formatUsd(num(item, 'cost_micros') ?? 0)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Outcome</TableHead>
                <TableHead>About</TableHead>
                <TableHead>Proven by</TableHead>
                <TableHead className="hidden md:table-cell">Employee</TableHead>
                <TableHead className="hidden sm:table-cell">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) => (
                <TableRow key={text(item, 'outcome_id')}>
                  <TableCell>{outcomeKeyLabel(text(item, 'outcome_key') ?? '')}</TableCell>
                  <TableCell className="font-mono text-xs">{text(item, 'subject') ?? '—'}</TableCell>
                  <TableCell>
                    {text(item, 'task_id') ? (
                      <Link href={`/app/tasks/${text(item, 'task_id')}`} className="underline underline-offset-4">
                        {text(item, 'tool_execution_id') ? 'The action in its task' : 'Its task'}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Not linked to a task</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{employeeName(text(item, 'employee_id'))}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <DateTime value={text(item, 'occurred_at')!} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {pages > 1 ? (
          <nav aria-label="Pages" className="mt-4 flex items-center gap-2 text-sm">
            {current > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={evidenceHref({ ...query, page: current - 1 })}>Previous</Link>
              </Button>
            ) : null}
            <span className="text-muted-foreground">
              Page {current} of {pages}
            </span>
            {current < pages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={evidenceHref({ ...query, page: current + 1 })}>Next</Link>
              </Button>
            ) : null}
          </nav>
        ) : null}
      </SectionCard>
    </>
  )
}

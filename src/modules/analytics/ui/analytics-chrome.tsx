// Shared pieces of the analytics pages: the period switcher, the legend that
// explains measured / calculated / estimate, and the per-scope breakdown table
// on the workspace page.

import Link from 'next/link'

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { formatUsd } from '@/modules/models/domain/catalog'

import { formatCount, formatPercent, rate } from '../domain/calculations'
import { BASIS_DESCRIPTIONS, METRIC_BASES } from '../domain/metrics'
import { ANALYTICS_PERIOD_LABELS, ANALYTICS_PERIODS, type AnalyticsPeriod } from '../domain/period'
import type { AnalyticsReport } from '../server/queries'
import { BasisBadge } from './metric-tile'

export function PeriodSwitcher({ basePath, period }: { basePath: string; period: AnalyticsPeriod }) {
  return (
    <nav aria-label="Period" className="flex flex-wrap gap-1">
      {ANALYTICS_PERIODS.map((key) => (
        <Link
          key={key}
          href={`${basePath}?period=${key}`}
          aria-current={period.key === key ? 'page' : undefined}
          className={cn(
            'rounded-md border px-2.5 py-1 text-sm',
            period.key === key ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {ANALYTICS_PERIOD_LABELS[key]}
        </Link>
      ))}
    </nav>
  )
}

export function BasisLegend({ period }: { period: AnalyticsPeriod }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <p>
        <span className="font-medium">{period.label}:</span> {period.from.toISOString().slice(0, 16).replace('T', ' ')} to {period.to.toISOString().slice(0, 16).replace('T', ' ')} UTC.
        Every number comes from records Nexefiy keeps; follow a number to see them.{' '}
        <Link href="/app/analytics/definitions" className="underline underline-offset-4">
          How each metric is computed
        </Link>
      </p>
      <ul className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-4">
        {METRIC_BASES.map((basis) => (
          <li key={basis} className="flex items-center gap-2 text-muted-foreground">
            <BasisBadge basis={basis} />
            <span className="text-xs">{BASIS_DESCRIPTIONS[basis]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface BreakdownRow {
  key: string
  name: string
  href: string
}

/** Key task numbers for each department, employee or workflow, linking to its own page. */
export function TaskBreakdownTable({ report, grain, rows, label }: { report: AnalyticsReport; grain: 'department' | 'employee' | 'workflow'; rows: BreakdownRow[]; label: string }) {
  const byKey = new Map(report.tasks.filter((row) => row.grain === grain).map((row) => [row.key, row]))
  const visible = rows.filter((row) => byKey.has(row.key))
  if (visible.length === 0) return <p className="text-sm text-muted-foreground">No tasks in this period.</p>
  return (
    <Table>
      <TableCaption className="text-left text-xs">* Fewer than 10 finished tasks: read with care.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className="text-right">Created</TableHead>
          <TableHead className="text-right">Completed</TableHead>
          <TableHead className="text-right">Verified rate</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Failed</TableHead>
          <TableHead className="hidden text-right md:table-cell">Needed a person</TableHead>
          <TableHead className="hidden text-right md:table-cell">Model cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map((row) => {
          const metrics = byKey.get(row.key)!
          const verified = rate(metrics.tasks_verified, metrics.tasks_finished)
          return (
            <TableRow key={row.key}>
              <TableCell>
                <Link href={row.href} className="font-medium underline-offset-4 hover:underline">
                  {row.name}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(metrics.tasks_created)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(metrics.tasks_completed)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {verified.value === null ? '—' : formatPercent(verified.value)}
                {verified.smallSample ? <span className="sr-only"> (small sample)</span> : null}
                {verified.smallSample ? <span aria-hidden="true">*</span> : null}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatCount(metrics.tasks_failed)}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{formatCount(metrics.tasks_intervened)}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{formatUsd(metrics.cost_micros)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** Run numbers for each workflow, linking to its own page. */
export function WorkflowBreakdownTable({ report, rows }: { report: AnalyticsReport; rows: BreakdownRow[] }) {
  const byKey = new Map(report.runs.filter((row) => row.grain === 'workflow').map((row) => [row.key, row]))
  const visible = rows.filter((row) => byKey.has(row.key))
  if (visible.length === 0) return <p className="text-sm text-muted-foreground">No workflow runs in this period.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Workflow</TableHead>
          <TableHead className="text-right">Runs</TableHead>
          <TableHead className="text-right">Success rate</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Failed</TableHead>
          <TableHead className="hidden text-right md:table-cell">Still running</TableHead>
          <TableHead className="hidden text-right md:table-cell">Model cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map((row) => {
          const runs = byKey.get(row.key)!
          const success = rate(runs.runs_succeeded, runs.runs_finished)
          return (
            <TableRow key={row.key}>
              <TableCell>
                <Link href={row.href} className="font-medium underline-offset-4 hover:underline">
                  {row.name}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(runs.runs_started)}</TableCell>
              <TableCell className="text-right tabular-nums">{success.value === null ? '—' : formatPercent(success.value)}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatCount(runs.runs_failed)}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{formatCount(runs.runs_open)}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{formatUsd(runs.cost_micros)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

// The analytics of one scope (the workspace, a department, an employee or a
// workflow): outcomes, then each group of metrics, failures and integration
// errors, and (workspace only) all model usage. Every number links to the
// rows behind it.

import Link from 'next/link'

import { SectionCard } from '@/components/cards'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatUsd } from '@/modules/models/domain/catalog'
import { FAILURE_CLASS_LABELS } from '@/modules/tasks/domain/labels'

import { formatCount, scopeMetrics, scopeOutcomes, type ScopeMetrics } from '../domain/calculations'
import { evidenceHref } from '../domain/evidence'
import { getMetric, METRIC_GROUP_LABELS, metricsForGroup, type Grain, type MetricGroup } from '../domain/metrics'
import { getOutcome, OUTCOMES, outcomeKeyLabel } from '../domain/outcomes'
import type { AnalyticsReport } from '../server/queries'
import { BasisBadge, formatMetric, MetricTile } from './metric-tile'

const ANALYTICS_GROUPS: readonly MetricGroup[] = ['work', 'reliability', 'people', 'time', 'cost', 'integrations', 'workflows']

const GROUP_NOTES: Partial<Record<MetricGroup, string>> = {
  work: 'AI employee tasks created in the period and what has happened to them so far. Open tasks are left out of every rate.',
  integrations: 'Actions in connected apps requested in the period by AI employees and workflow steps.',
  workflows: 'Workflow runs started in the period.',
}

export interface Scope {
  grain: Grain
  /** Department, employee id or workflow id; the organization id for the workspace. */
  key: string
  name: string
}

export function ScopeDashboard({ report, scope }: { report: AnalyticsReport; scope: Scope }) {
  const evidenceKey = scope.grain === 'organization' ? undefined : scope.key
  const pick = <T extends { grain: string; key: string }>(rows: readonly T[]) => rows.find((row) => row.grain === scope.grain && row.key === scope.key)
  const metrics = scopeMetrics({
    tasks: pick(report.tasks),
    actions: pick(report.actions),
    runs: scope.grain === 'organization' || scope.grain === 'workflow' ? pick(report.runs) : undefined,
  })
  const link = (ref: { source: 'task' | 'action' | 'run' | 'outcome'; flag: string } | undefined, title: string) =>
    ref ? evidenceHref({ ...ref, grain: scope.grain, key: evidenceKey, period: report.period, title: `${title} · ${scope.name}` }) : undefined

  return (
    <div className="flex flex-col gap-6">
      <OutcomesSection report={report} scope={scope} metrics={metrics} />
      {ANALYTICS_GROUPS.filter((group) => metricsForGroup(group, scope.grain).length > 0).map((group) => (
        <SectionCard key={group} title={METRIC_GROUP_LABELS[group]} description={GROUP_NOTES[group]}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {metricsForGroup(group, scope.grain).map((metric) => (
              <MetricTile
                key={metric.key}
                metric={metric}
                value={metrics[metric.key]}
                evidenceHref={link(metric.evidence, metric.label)}
                denominatorHref={metric.denominator ? link(metric.denominator, `${metric.label} (denominator)`) : undefined}
              />
            ))}
          </div>
          {group === 'reliability' ? <FailuresTable report={report} scope={scope} /> : null}
          {group === 'integrations' && scope.grain === 'organization' ? <IntegrationErrorsTable report={report} /> : null}
        </SectionCard>
      ))}
      {scope.grain === 'organization' ? <UsageSection report={report} /> : null}
    </div>
  )
}

function OutcomesSection({ report, scope, metrics }: { report: AnalyticsReport; scope: Scope; metrics: ScopeMetrics }) {
  const values = scopeOutcomes(report.outcomes, scope.grain, scope.key, (key) => getOutcome(key)?.count ?? 'records')
  const valueOf = (key: string) => values.find((value) => value.outcomeKey === key)
  const measured = OUTCOMES.filter((outcome) => outcome.support === 'measured')
  const unsupported = OUTCOMES.filter((outcome) => outcome.support === 'unsupported')
  const other = values.filter((value) => !measured.some((outcome) => outcome.key === value.outcomeKey))
  const response = getMetric('response_time_p50')
  const evidenceKey = scope.grain === 'organization' ? undefined : scope.key

  return (
    <SectionCard
      title="Business outcomes"
      description="Recorded only when an AI employee’s or workflow’s action succeeded in a connected app and proves it. Each links to the actions behind it. Outcomes the connected apps can’t report are listed, not guessed."
    >
      <div className="flex flex-col gap-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">In this period</TableHead>
              <TableHead className="hidden md:table-cell">How it is counted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {measured.map((outcome) => {
              const value = valueOf(outcome.key)
              return (
                <TableRow key={outcome.key}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {outcome.label} <BasisBadge basis={outcome.basis} />
                    </div>
                    <p className="text-xs text-muted-foreground">{outcome.description}</p>
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">
                    {value ? (
                      <Link
                        href={evidenceHref({ source: 'outcome', flag: outcome.key, grain: scope.grain, key: evidenceKey, period: report.period, title: `${outcome.label} · ${scope.name}` })}
                        className="underline underline-offset-4"
                      >
                        {formatCount(value.value)}
                      </Link>
                    ) : (
                      '0'
                    )}
                  </TableCell>
                  <TableCell className="hidden align-top text-xs whitespace-normal text-muted-foreground md:table-cell">{outcome.method}</TableCell>
                </TableRow>
              )
            })}
            <TableRow>
              <TableCell className="align-top whitespace-normal">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {response.label} <BasisBadge basis={response.basis} />
                </div>
                <p className="text-xs text-muted-foreground">{response.description}</p>
              </TableCell>
              <TableCell className="text-right align-top tabular-nums">
                <MetricLink metrics={metrics} report={report} scope={scope} />
              </TableCell>
              <TableCell className="hidden align-top text-xs whitespace-normal text-muted-foreground md:table-cell">{response.method}</TableCell>
            </TableRow>
            {other.map((value) => (
              <TableRow key={value.outcomeKey}>
                <TableCell className="align-top whitespace-normal">
                  <div className="font-medium">{outcomeKeyLabel(value.outcomeKey)}</div>
                  <p className="text-xs text-muted-foreground">Recorded by another source, not proven by an action of an AI employee.</p>
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  <Link
                    href={evidenceHref({ source: 'outcome', flag: value.outcomeKey, grain: scope.grain, key: evidenceKey, period: report.period, title: `${outcomeKeyLabel(value.outcomeKey)} · ${scope.name}` })}
                    className="underline underline-offset-4"
                  >
                    {formatCount(value.records)}
                  </Link>
                </TableCell>
                <TableCell className="hidden md:table-cell" />
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">Not measurable yet</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {unsupported.map((outcome) => (
              <li key={outcome.key}>
                {outcome.label}: {outcome.requires}
              </li>
            ))}
            <li>
              Revenue and hours saved: not reported (see{' '}
              <Link href="/app/analytics/definitions#not-reported" className="underline underline-offset-4">
                why
              </Link>
              ).
            </li>
          </ul>
        </div>
      </div>
    </SectionCard>
  )
}

function MetricLink({ metrics, report, scope }: { metrics: ScopeMetrics; report: AnalyticsReport; scope: Scope }) {
  const metric = getMetric('response_time_p50')
  const value = metrics.response_time_p50
  if (!value || value.value === null) return <span className="text-muted-foreground">No messages yet</span>
  const href = evidenceHref({ ...metric.evidence!, grain: scope.grain, key: scope.grain === 'organization' ? undefined : scope.key, period: report.period, title: `${metric.label} · ${scope.name}` })
  return (
    <Link href={href} className="underline underline-offset-4">
      {formatMetric('duration', value.value)}
    </Link>
  )
}

function FailuresTable({ report, scope }: { report: AnalyticsReport; scope: Scope }) {
  const rows = report.failures.filter((row) => row.grain === scope.grain && row.key === scope.key).sort((left, right) => right.tasks - left.tasks)
  if (rows.length === 0) return null
  return (
    <div className="mt-4 flex flex-col gap-2">
      <h3 className="text-sm font-medium">Why tasks failed</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Failure</TableHead>
            <TableHead>Code</TableHead>
            <TableHead className="text-right">Tasks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.failure_class}:${row.failure_code}`}>
              <TableCell>{FAILURE_CLASS_LABELS[row.failure_class as keyof typeof FAILURE_CLASS_LABELS] ?? row.failure_class}</TableCell>
              <TableCell className="font-mono text-xs">{row.failure_code}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(row.tasks)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function IntegrationErrorsTable({ report }: { report: AnalyticsReport }) {
  const providers = report.actions.filter((row) => row.grain === 'provider')
  if (providers.length === 0) return null
  const errors = report.actions.filter((row) => row.grain === 'provider_error')
  return (
    <div className="mt-4 flex flex-col gap-2">
      <h3 className="text-sm font-medium">By app</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>App</TableHead>
            <TableHead className="text-right">Requested</TableHead>
            <TableHead className="text-right">Succeeded</TableHead>
            <TableHead className="text-right">Errors</TableHead>
            <TableHead className="hidden sm:table-cell">Error codes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="capitalize">{row.key}</TableCell>
              <TableCell className="text-right tabular-nums">
                <Link href={evidenceHref({ source: 'action', flag: 'requested', grain: 'provider', key: row.key, period: report.period, title: `Actions · ${row.key}` })} className="underline underline-offset-4">
                  {formatCount(row.actions_requested)}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(row.actions_succeeded)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {row.actions_failed ? (
                  <Link href={evidenceHref({ source: 'action', flag: 'failed', grain: 'provider', key: row.key, period: report.period, title: `Integration errors · ${row.key}` })} className="underline underline-offset-4">
                    {formatCount(row.actions_failed)}
                  </Link>
                ) : (
                  '0'
                )}
              </TableCell>
              <TableCell className="hidden whitespace-normal sm:table-cell">
                <div className="flex flex-wrap gap-1">
                  {errors
                    .filter((error) => error.key === row.key)
                    .map((error) => (
                      <Link
                        key={error.error_code}
                        href={evidenceHref({ source: 'action', flag: 'failed', grain: 'provider_error', key: `${row.key}:${error.error_code}`, period: report.period, title: `${error.error_code} · ${row.key}` })}
                      >
                        <Badge variant="outline" className="font-mono">
                          {error.error_code} × {error.actions_failed}
                        </Badge>
                      </Link>
                    ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function UsageSection({ report }: { report: AnalyticsReport }) {
  const total = getMetric('model_cost_total')
  const tests = getMetric('model_cost_tests')
  const projected = getMetric('projected_month_model_cost')
  if (!report.usage) {
    return (
      <SectionCard title={METRIC_GROUP_LABELS.usage} description={total.description}>
        <p className="text-sm text-muted-foreground">Only admins and owners can see the workspace’s full model spend. The cost of the tasks above is shown to everyone.</p>
      </SectionCard>
    )
  }
  const { summary, projection } = report.usage
  return (
    <SectionCard title={METRIC_GROUP_LABELS.usage} description="Every model call in the period, from tasks and from test runs. Visible to admins and owners.">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricTile metric={total} value={{ value: summary.totalMicros }} note={`${formatCount(summary.calls)} model calls · ${formatCount(summary.inputTokens)} input and ${formatCount(summary.outputTokens)} output tokens`} />
        <MetricTile metric={tests} value={{ value: summary.testMicros }} />
        <MetricTile
          metric={projected}
          value={{ value: projection.value }}
          note={
            projection.value === null
              ? projection.reason
              : `${formatUsd(projection.monthToDateMicros)} in ${projection.daysElapsed.toFixed(1)} of ${projection.daysInMonth} days, extended at the same daily rate. ${projected.method}`
          }
        />
      </div>
      {summary.byModel.length ? (
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Cost at list prices</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.byModel.map((model) => (
              <TableRow key={model.model}>
                <TableCell className="font-mono text-xs">{model.model}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(model.calls)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatUsd(model.costMicros)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </SectionCard>
  )
}

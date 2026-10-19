// One analytics number: its value, whether it is measured, calculated or an
// estimate, the counts it rests on, and links to the rows behind it.

import { TriangleAlert } from 'lucide-react'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { formatUsd } from '@/modules/models/domain/catalog'
import { formatDuration } from '@/modules/tasks/domain/task-center'

import { formatCount, formatPercent, type MetricValue } from '../domain/calculations'
import { BASIS_DESCRIPTIONS, BASIS_LABELS, type FactSource, type MetricBasis, type MetricDefinition, type MetricUnit } from '../domain/metrics'

export function formatMetric(unit: MetricUnit, value: number): string {
  switch (unit) {
    case 'count':
    case 'tokens':
      return formatCount(value)
    case 'percent':
      return formatPercent(value)
    case 'duration':
      return formatDuration(value)
    case 'usd':
      return formatUsd(value)
  }
}

const NOUNS: Record<FactSource, [string, string]> = {
  task: ['task', 'tasks'],
  action: ['action', 'actions'],
  run: ['run', 'runs'],
  outcome: ['record', 'records'],
}

export function rowsLabel(source: FactSource, count: number): string {
  const [one, many] = NOUNS[source]
  return `${formatCount(count)} ${count === 1 ? one : many}`
}

export function BasisBadge({ basis }: { basis: MetricBasis }) {
  return (
    <Badge variant={basis === 'estimate' ? 'secondary' : 'outline'} title={BASIS_DESCRIPTIONS[basis]}>
      {BASIS_LABELS[basis]}
      {basis === 'estimate' ? <span className="sr-only">: {BASIS_DESCRIPTIONS.estimate}</span> : null}
    </Badge>
  )
}

export function MetricTile({
  metric,
  value,
  evidenceHref,
  denominatorHref,
  note,
}: {
  metric: MetricDefinition
  value: MetricValue | undefined
  /** Rows counted (a rate's numerator, the rows a median is taken over). */
  evidenceHref?: string
  /** A rate's denominator rows. */
  denominatorHref?: string
  note?: string
}) {
  const current = value?.value ?? null
  const source = metric.evidence?.source
  return (
    <Card size="sm" className="gap-2">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardDescription>{metric.label}</CardDescription>
        <BasisBadge basis={metric.basis} />
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {current === null ? (
          <p className="text-sm font-medium text-muted-foreground">{metric.unit === 'percent' ? 'Nothing to compute yet' : 'No data in this period'}</p>
        ) : (
          <p className="text-2xl font-semibold tabular-nums">{formatMetric(metric.unit, current)}</p>
        )}
        {value?.denominator !== undefined && value.numerator !== undefined && metric.unit === 'percent' && source ? (
          <p className="text-xs text-muted-foreground">
            {evidenceHref ? (
              <Link href={evidenceHref} className="underline underline-offset-4">
                {formatCount(value.numerator)}
              </Link>
            ) : (
              formatCount(value.numerator)
            )}{' '}
            of{' '}
            {denominatorHref ? (
              <Link href={denominatorHref} className="underline underline-offset-4">
                {rowsLabel(metric.denominator?.source ?? source, value.denominator)}
              </Link>
            ) : (
              rowsLabel(metric.denominator?.source ?? source, value.denominator)
            )}
          </p>
        ) : null}
        {metric.unit !== 'percent' && evidenceHref ? (
          <p className="text-xs">
            <Link href={evidenceHref} className="text-muted-foreground underline underline-offset-4">
              {metric.unit === 'duration' && value?.sample !== undefined
                ? `Over ${rowsLabel(source ?? 'task', value.sample)}`
                : metric.unit === 'usd' && value?.denominator !== undefined && denominatorHref
                  ? 'Costs behind it'
                  : 'See the records'}
            </Link>
            {metric.unit === 'usd' && value?.denominator !== undefined && denominatorHref ? (
              <>
                {' · '}
                <Link href={denominatorHref} className="text-muted-foreground underline underline-offset-4">
                  {rowsLabel(metric.denominator?.source ?? 'task', value.denominator)}
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {value?.smallSample ? (
          <p className="flex items-center gap-1 text-xs font-medium">
            <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            Small sample ({formatCount(value.sample ?? 0)}): read with care.
          </p>
        ) : null}
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        <p className="text-xs text-muted-foreground">{metric.description}</p>
      </CardContent>
    </Card>
  )
}

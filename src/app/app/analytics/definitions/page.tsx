import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { BASIS_DESCRIPTIONS, BASIS_LABELS, METRIC_BASES, METRIC_GROUP_LABELS, METRIC_GROUPS, METRICS, NOT_REPORTED } from '@/modules/analytics/domain/metrics'
import { OUTCOMES } from '@/modules/analytics/domain/outcomes'
import { BasisBadge } from '@/modules/analytics/ui/metric-tile'

export const metadata: Metadata = { title: 'Metric definitions' }

const GRAIN_LABELS = { organization: 'workspace', department: 'department', employee: 'employee', workflow: 'workflow' } as const

export default function DefinitionsPage() {
  return (
    <>
      <div>
        <Link href="/app/analytics" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Analytics
        </Link>
      </div>
      <PageHeader
        title="Metric definitions"
        description="What each number means, exactly how it is computed, and which records it comes from. Tasks are counted by when they were created; actions by when they were requested; runs by when they were queued; outcomes and model usage by when they happened. All times are UTC."
      />
      <SectionCard title="Measured, calculated or estimated">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {METRIC_BASES.map((basis) => (
            <div key={basis} className="contents">
              <dt className="font-medium">{BASIS_LABELS[basis]}</dt>
              <dd className="text-muted-foreground">{BASIS_DESCRIPTIONS[basis]}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
      {METRIC_GROUPS.map((group) => (
        <SectionCard key={group} title={METRIC_GROUP_LABELS[group]}>
          <dl className="flex flex-col gap-4">
            {METRICS.filter((metric) => metric.group === group).map((metric) => (
              <div key={metric.key} id={metric.key} className="flex flex-col gap-1 text-sm">
                <dt className="flex flex-wrap items-center gap-2 font-medium">
                  {metric.label} <BasisBadge basis={metric.basis} />
                  {metric.adminOnly ? <span className="text-xs font-normal text-muted-foreground">Admins and owners</span> : null}
                </dt>
                <dd className="text-muted-foreground">{metric.description}</dd>
                <dd>
                  <span className="font-medium">Method:</span> {metric.method}
                </dd>
                <dd className="text-xs text-muted-foreground">For: {metric.grains.map((grain) => GRAIN_LABELS[grain]).join(', ')}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
      ))}
      <SectionCard title="Business outcomes">
        <dl className="flex flex-col gap-4">
          {OUTCOMES.map((outcome) => (
            <div key={outcome.key} id={outcome.key} className="flex flex-col gap-1 text-sm">
              <dt className="flex flex-wrap items-center gap-2 font-medium">
                {outcome.label} {outcome.support === 'measured' ? <BasisBadge basis={outcome.basis} /> : <span className="text-xs font-normal text-muted-foreground">Not measurable yet</span>}
              </dt>
              <dd className="text-muted-foreground">{outcome.description}</dd>
              <dd>{outcome.support === 'measured' ? <><span className="font-medium">Method:</span> {outcome.method}</> : <><span className="font-medium">Needs:</span> {outcome.requires}</>}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
      <SectionCard title="Deliberately not reported" description="Numbers that would need data Nexefiy doesn’t have. Showing them would mean guessing.">
        <dl id="not-reported" className="flex flex-col gap-3 text-sm">
          {NOT_REPORTED.map((item) => (
            <div key={item.label}>
              <dt className="font-medium">{item.label}</dt>
              <dd className="text-muted-foreground">{item.reason}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
    </>
  )
}

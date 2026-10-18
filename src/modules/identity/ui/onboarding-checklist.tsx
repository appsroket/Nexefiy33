// Getting-started checklist on the overview page. Progress is derived from
// real workspace data (see domain/onboarding.ts); planned steps are labelled
// and never counted.

import { CircleCheck, CircleDashed, Clock } from 'lucide-react'
import Link from 'next/link'

import { SectionCard } from '@/components/cards'
import { StatusIndicator } from '@/components/status-badge'

import type { OnboardingProgress } from '../domain/onboarding'

export function OnboardingChecklist({ progress }: { progress: OnboardingProgress }) {
  return (
    <SectionCard
      title="Get your workspace ready"
      description={`${progress.completed} of ${progress.total} steps done.`}
    >
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.completed}
        className="mb-4 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${progress.total ? Math.round((progress.completed / progress.total) * 100) : 0}%` }}
        />
      </div>
      <ol className="flex flex-col gap-1">
        {progress.steps.map((step) => {
          const Icon = step.status === 'done' ? CircleCheck : step.status === 'planned' ? Clock : CircleDashed
          const body = (
            <>
              <Icon
                aria-hidden="true"
                className={step.status === 'done' ? 'mt-0.5 size-4 shrink-0 text-success' : 'mt-0.5 size-4 shrink-0 text-muted-foreground'}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {step.title}
                  {step.status === 'done' ? <span className="sr-only">(done)</span> : null}
                  {step.status === 'planned' ? <StatusIndicator tone="neutral" label="Coming soon" /> : null}
                </span>
                <span className="text-sm text-muted-foreground">{step.description}</span>
              </span>
            </>
          )
          return (
            <li key={step.id}>
              {step.status === 'todo' && step.href ? (
                <Link
                  href={step.href}
                  className="-mx-2 flex gap-3 rounded-lg px-2 py-2 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {body}
                </Link>
              ) : (
                <div className="-mx-2 flex gap-3 px-2 py-2">{body}</div>
              )}
            </li>
          )
        })}
      </ol>
    </SectionCard>
  )
}

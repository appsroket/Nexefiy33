import { ShieldCheck } from 'lucide-react'

import { EMPLOYEE_CATEGORIES } from '@/modules/marketing/domain/employees'
import { USE_CASES } from '@/modules/marketing/domain/use-cases'
import { CtaBand, EmployeeIconBadge } from '@/modules/marketing/ui/content-blocks'
import {
  CapabilityStatusBadge,
  Container,
  IllustrativeNote,
  PageIntro,
  StatusLegend,
  TextLink,
} from '@/modules/marketing/ui/layout-primitives'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('useCases')

export default function UseCasesPage() {
  return (
    <>
      <PageIntro
        eyebrow="Use cases"
        title="What supervised AI employees could take off your plate"
        lead={
          <>
            Scenarios showing how Nexefiy is designed to handle everyday work across sales, support, marketing,
            operations, analytics and voice. Each one keeps a person in control of anything that leaves your business.
          </>
        }
      >
        <IllustrativeNote>
          these are design scenarios, not customer stories. Nexefiy has no customers yet, and none of these scenarios
          can be run today.
        </IllustrativeNote>
      </PageIntro>

      <Container className="flex flex-col gap-8 py-14 sm:py-20">
        <StatusLegend />
        <nav aria-label="Use cases on this page">
          <ul className="flex flex-wrap gap-2">
            {USE_CASES.map((useCase) => (
              <li key={useCase.id}>
                <a
                  href={`#${useCase.id}`}
                  className="inline-flex rounded-full border bg-background px-3 py-1 text-sm hover:bg-muted"
                >
                  {useCase.category}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex flex-col gap-6">
          {USE_CASES.map((useCase) => {
            const category = EMPLOYEE_CATEGORIES.find((candidate) => candidate.id === useCase.categoryId)!
            return (
              <article
                key={useCase.id}
                id={useCase.id}
                aria-labelledby={`${useCase.id}-heading`}
                className="grid scroll-mt-24 gap-6 rounded-2xl border bg-card p-6 lg:grid-cols-[1fr_1.2fr]"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <EmployeeIconBadge icon={category.icon} />
                    <p className="text-sm font-medium text-primary">{useCase.category}</p>
                    <CapabilityStatusBadge status={useCase.status} />
                  </div>
                  <h2 id={`${useCase.id}-heading`} className="text-xl font-semibold tracking-tight text-balance">
                    {useCase.title}
                  </h2>
                  <p className="text-pretty text-muted-foreground">{useCase.situation}</p>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">Apps: </span>
                    {useCase.apps.join(', ')}
                  </p>
                </div>
                <div className="flex flex-col gap-4">
                  <div>
                    <h3 className="text-sm font-medium">How it would work</h3>
                    <ol className="mt-2 flex flex-col gap-2">
                      {useCase.steps.map((step, index) => (
                        <li key={step} className="flex gap-3 text-sm">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                            {index + 1}
                          </span>
                          <span className="pt-0.5 text-pretty">{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <p className="flex gap-2 rounded-lg bg-muted/60 p-3 text-sm">
                    <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>
                      <span className="font-medium">Where you stay in control: </span>
                      {useCase.control}
                    </span>
                  </p>
                </div>
              </article>
            )
          })}
        </div>
        <p className="text-sm text-muted-foreground">
          Have a different process in mind? <TextLink href="/contact?topic=product">Tell us about it</TextLink>.
        </p>
      </Container>

      <CtaBand />
    </>
  )
}

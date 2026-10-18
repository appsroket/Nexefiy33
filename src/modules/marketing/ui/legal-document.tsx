// Frame for draft legal documents: a prominent "draft, not in effect" notice,
// a table of contents, and readable typography for the sections.

import { FileWarning } from 'lucide-react'
import type { ReactNode } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

import { Container } from './layout-primitives'

export interface LegalSection {
  id: string
  title: string
  body: ReactNode
}

export const LEGAL_DRAFT_NOTICE =
  'This is a draft written to start legal review. It has not been reviewed by a lawyer, is not in effect, and does not govern any use of Nexefiy. Text in [square brackets] is a placeholder to complete.'

export function LegalDocument({ title, summary, sections }: { title: string; summary: string; sections: readonly LegalSection[] }) {
  return (
    <Container className="flex flex-col gap-8 py-12 sm:py-16">
      <header className="flex max-w-3xl flex-col gap-4">
        <p className="text-sm font-medium text-primary">Legal · Draft</p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        <p className="text-pretty text-muted-foreground">{summary}</p>
        <Alert className="border-warning/50 bg-warning/10">
          <FileWarning aria-hidden="true" />
          <AlertTitle>Draft for legal review: not in effect</AlertTitle>
          <AlertDescription>{LEGAL_DRAFT_NOTICE}</AlertDescription>
        </Alert>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd>Draft, not in effect</dd>
          <dt className="text-muted-foreground">Effective date</dt>
          <dd>[To be set after legal review]</dd>
        </dl>
      </header>

      <div className="grid gap-10 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <h2 className="text-sm font-semibold">On this page</h2>
          <ol className="mt-3 flex flex-col gap-1.5 text-sm">
            {sections.map((section, index) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-muted-foreground hover:text-foreground hover:underline">
                  {index + 1}. {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex max-w-3xl flex-col gap-10">
          {sections.map((section, index) => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`} className="scroll-mt-24">
              <h2 id={`${section.id}-heading`} className="text-xl font-semibold tracking-tight">
                {index + 1}. {section.title}
              </h2>
              <div className="mt-3 flex flex-col gap-3 text-pretty text-muted-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5">
                {section.body}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Container>
  )
}

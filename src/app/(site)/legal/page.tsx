import { FileWarning } from 'lucide-react'
import Link from 'next/link'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { Container } from '@/modules/marketing/ui/layout-primitives'
import { LEGAL_DRAFT_NOTICE } from '@/modules/marketing/ui/legal-document'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

export const metadata = pageMetadata('legal')

const DOCUMENTS = [
  { page: PUBLIC_PAGES.terms, label: 'Terms of Service', summary: 'The terms for using Nexefiy.' },
  { page: PUBLIC_PAGES.privacy, label: 'Privacy Policy', summary: 'How personal information is collected and used.' },
  { page: PUBLIC_PAGES.acceptableUse, label: 'Acceptable Use Policy', summary: 'What Nexefiy may not be used for.' },
] as const

export default function LegalIndexPage() {
  return (
    <Container className="flex max-w-3xl flex-col gap-8 py-12 sm:py-16">
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Legal</h1>
        <Alert className="border-warning/50 bg-warning/10">
          <FileWarning aria-hidden="true" />
          <AlertTitle>All documents here are drafts</AlertTitle>
          <AlertDescription>{LEGAL_DRAFT_NOTICE}</AlertDescription>
        </Alert>
      </div>
      <ul className="flex flex-col divide-y rounded-xl border bg-card">
        {DOCUMENTS.map((document) => (
          <li key={document.page.path} className="flex flex-col gap-1 p-5">
            <Link href={document.page.path} className="font-semibold text-primary underline-offset-4 hover:underline">
              {document.label} (draft)
            </Link>
            <p className="text-sm text-muted-foreground">{document.summary}</p>
          </li>
        ))}
      </ul>
    </Container>
  )
}

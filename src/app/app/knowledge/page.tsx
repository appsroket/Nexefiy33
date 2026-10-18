import { CircleCheck, Circle, Info } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { MetricCard, SectionCard } from '@/components/cards'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { isFeatureConfigured } from '@/lib/env/server'
import { createUserClient } from '@/lib/supabase/server'
import { profileCompleteness } from '@/modules/knowledge/domain/business-context'
import { CONTEXT_KIND_DEFINITIONS, CONTEXT_KINDS } from '@/modules/knowledge/domain/context-kinds'
import { countByStatus, getBusinessContext, listKnowledgeSources } from '@/modules/knowledge/server/queries'
import { canProcessKnowledge } from '@/modules/knowledge/server/scheduling'
import { KnowledgeFrame, knowledgeGate } from '@/modules/knowledge/ui/knowledge-frame'

export const metadata: Metadata = { title: 'Knowledge' }

export default async function KnowledgeOverviewPage() {
  const gate = await knowledgeGate()
  if (!gate.ok) return gate.page
  const { workspace } = gate

  const supabase = await createUserClient()
  const [context, sources] = await Promise.all([
    getBusinessContext(supabase, workspace.organizationId, workspace.name),
    listKnowledgeSources(supabase, workspace.organizationId),
  ])
  const completeness = profileCompleteness(context)
  const documents = countByStatus(sources.filter((source) => source.sourceType === 'file'))
  const all = countByStatus(sources)
  const processing = canProcessKnowledge()
  const semantic = isFeatureConfigured('embeddings')

  return (
    <KnowledgeFrame>
      {!processing ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle>Processing is not set up on this deployment</AlertTitle>
          <AlertDescription>
            You can add business context and upload documents, but they stay queued until the server has its Supabase secret key
            (SUPABASE_SECRET_KEY). Search only covers indexed content.
          </AlertDescription>
        </Alert>
      ) : !semantic ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle>Keyword search only</AlertTitle>
          <AlertDescription>
            Documents are indexed for keyword search. Add a Voyage AI key (VOYAGE_API_KEY) for search by meaning, then reprocess documents.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Profile complete" value={`${completeness.done} of ${completeness.total}`} />
        <MetricCard label="Documents ready" value={String(documents.ready)} />
        <MetricCard label="Waiting or failed" value={String(all.pending + all.processing + all.failed)} />
      </div>

      <SectionCard title="Set up your business context" description="What every AI employee should know before it starts work.">
        <ul className="grid gap-2 sm:grid-cols-2">
          {[
            ['Company description', '/app/knowledge/profile'],
            ['Industry', '/app/knowledge/profile'],
            ['Operating hours', '/app/knowledge/profile'],
            ['Brand voice', '/app/knowledge/profile'],
            ['Products and services', '/app/knowledge/context/products'],
            ['Target customers', '/app/knowledge/context/customers'],
            ['Escalation contacts', '/app/knowledge/context/contacts'],
            ['Frequently asked questions', '/app/knowledge/context/faqs'],
          ].map(([label, href]) => {
            const missing = completeness.missing.includes(label!)
            return (
              <li key={label}>
                <Link href={href!} className="flex items-center gap-2 rounded-md p-1 text-sm hover:bg-muted">
                  {missing ? <Circle className="size-4 text-muted-foreground" aria-hidden="true" /> : <CircleCheck className="size-4 text-success" aria-hidden="true" />}
                  <span>{label}</span>
                  <span className="sr-only">{missing ? '(not set)' : '(done)'}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </SectionCard>

      <SectionCard title="Business context" description="Structured details employees use. Everything except escalation contacts is also searchable.">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CONTEXT_KINDS.map((kind) => {
            const definition = CONTEXT_KIND_DEFINITIONS[kind]
            const count = context.items[kind]?.length ?? 0
            return (
              <li key={kind}>
                <Link href={`/app/knowledge/context/${definition.slug}`} className="flex h-full flex-col gap-1 rounded-lg border p-3 hover:bg-muted">
                  <span className="text-sm font-medium">{definition.plural}</span>
                  <span className="text-xs text-muted-foreground">
                    {count} {count === 1 ? 'entry' : 'entries'}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </SectionCard>
    </KnowledgeFrame>
  )
}

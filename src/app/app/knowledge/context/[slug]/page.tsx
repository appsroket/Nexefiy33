import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { EmptyState } from '@/components/empty-state'
import { createUserClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'
import { canManageContextKind, CONTEXT_KIND_DEFINITIONS, CONTEXT_KINDS, contextKindBySlug } from '@/modules/knowledge/domain/context-kinds'
import { listContextItems, listKnowledgeSources } from '@/modules/knowledge/server/queries'
import { ContextItemDialog, ContextItemList } from '@/modules/knowledge/ui/context-items'
import { KnowledgeFrame, knowledgeGate } from '@/modules/knowledge/ui/knowledge-frame'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const definition = contextKindBySlug((await params).slug)
  return { title: definition?.plural ?? 'Business context' }
}

export default async function ContextKindPage({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug
  const definition = contextKindBySlug(slug)
  if (!definition) notFound()

  const gate = await knowledgeGate()
  if (!gate.ok) return gate.page
  const { workspace } = gate

  const supabase = await createUserClient()
  const [items, sources] = await Promise.all([
    listContextItems(supabase, workspace.organizationId, { kinds: [definition.kind], includeArchived: true }),
    definition.indexed ? listKnowledgeSources(supabase, workspace.organizationId, { sourceType: 'business_context' }) : Promise.resolve([]),
  ])
  const indexStatus = Object.fromEntries(sources.flatMap((source) => (source.contextItemId ? [[source.contextItemId, source.status]] : [])))
  const canManage = canManageContextKind(workspace.role, definition.kind)

  return (
    <KnowledgeFrame description="Structured details your AI employees use. Changes are indexed for search within moments.">
      <nav aria-label="Business context" className="flex flex-wrap gap-2">
        {CONTEXT_KINDS.map((kind) => {
          const other = CONTEXT_KIND_DEFINITIONS[kind]
          const current = other.slug === slug
          return (
            <Link
              key={kind}
              href={`/app/knowledge/context/${other.slug}`}
              aria-current={current ? 'page' : undefined}
              className={cn('rounded-full border px-3 py-1 text-sm', current ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
            >
              {other.plural}
            </Link>
          )
        })}
      </nav>
      <SectionCard
        title={definition.plural}
        description={`${definition.description}${canManage ? '' : definition.managedBy === 'admin' ? ' Only admins and owners can change these.' : ' Operators, admins and owners can change these.'}`}
        action={canManage && items.length ? <ContextItemDialog organizationId={workspace.organizationId} definition={definition} /> : undefined}
      >
        {items.length ? (
          <ContextItemList organizationId={workspace.organizationId} definition={definition} items={items} indexStatus={indexStatus} canManage={canManage} />
        ) : (
          <EmptyState
            title={`No ${definition.plural.toLowerCase()} yet`}
            description={definition.emptyHint}
            action={canManage ? <ContextItemDialog organizationId={workspace.organizationId} definition={definition} /> : undefined}
          />
        )}
      </SectionCard>
    </KnowledgeFrame>
  )
}

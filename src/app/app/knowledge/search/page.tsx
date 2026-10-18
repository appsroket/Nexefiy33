import type { Metadata } from 'next'

import { SectionCard } from '@/components/cards'
import { isFeatureConfigured } from '@/lib/env/server'
import { KnowledgeFrame, knowledgeGate } from '@/modules/knowledge/ui/knowledge-frame'
import { KnowledgeSearch } from '@/modules/knowledge/ui/knowledge-search'

export const metadata: Metadata = { title: 'Test knowledge search' }

export default async function KnowledgeSearchPage() {
  const gate = await knowledgeGate()
  if (!gate.ok) return gate.page

  return (
    <KnowledgeFrame description="Ask a question to see what an AI employee would find, with sources — or that there isn’t enough evidence.">
      <SectionCard title="Test search">
        <KnowledgeSearch organizationId={gate.workspace.organizationId} semanticAvailable={isFeatureConfigured('embeddings')} />
      </SectionCard>
    </KnowledgeFrame>
  )
}

import { FileText } from 'lucide-react'
import type { Metadata } from 'next'

import { SectionCard } from '@/components/cards'
import { EmptyState } from '@/components/empty-state'
import { createUserClient } from '@/lib/supabase/server'
import { canManageKnowledge } from '@/modules/knowledge/domain/context-kinds'
import { listKnowledgeSources } from '@/modules/knowledge/server/queries'
import { DocumentsTable, DocumentUpload, type DocumentView } from '@/modules/knowledge/ui/documents'
import { KnowledgeFrame, knowledgeGate } from '@/modules/knowledge/ui/knowledge-frame'

export const metadata: Metadata = { title: 'Documents' }

export default async function DocumentsPage() {
  const gate = await knowledgeGate()
  if (!gate.ok) return gate.page
  const { workspace } = gate

  const sources = await listKnowledgeSources(await createUserClient(), workspace.organizationId, { sourceType: 'file' })
  const documents: DocumentView[] = sources.map((source) => ({
    id: source.id,
    name: source.name,
    status: source.status,
    byteSize: source.byteSize,
    chunkCount: source.chunkCount,
    searchMode: source.status === 'ready' ? (source.embeddingModel ? 'hybrid' : 'keyword') : null,
    errorMessage: source.errorMessage,
    lastIndexedAt: source.lastIndexedAt,
    nextAttemptAt: source.nextAttemptAt,
    createdAt: source.createdAt,
    suspectedInstructionChunks: source.suspectedInstructionChunks,
  }))
  const canManage = canManageKnowledge(workspace.role)

  return (
    <KnowledgeFrame description="Policies, price lists, manuals and other documents AI employees can quote, with the source shown.">
      {canManage ? (
        <SectionCard title="Upload" description="Text in documents is treated as information, never as instructions to an AI employee.">
          <DocumentUpload organizationId={workspace.organizationId} />
        </SectionCard>
      ) : null}
      <SectionCard title="Documents" description={canManage ? undefined : 'Operators, admins and owners can upload and remove documents.'}>
        {documents.length ? (
          <DocumentsTable organizationId={workspace.organizationId} documents={documents} canManage={canManage} />
        ) : (
          <EmptyState icon={FileText} title="No documents yet" description="Uploaded documents appear here with their processing status." />
        )}
      </SectionCard>
    </KnowledgeFrame>
  )
}

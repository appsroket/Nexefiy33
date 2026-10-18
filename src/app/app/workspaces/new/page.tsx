import type { Metadata } from 'next'

import { SectionCard } from '@/components/cards'
import { PageHeader } from '@/components/page-header'
import { CreateWorkspaceForm } from '@/modules/identity/ui/workspace-forms'

export const metadata: Metadata = { title: 'Create a workspace' }

export default function NewWorkspacePage() {
  return (
    <>
      <PageHeader
        title="Create a workspace"
        description="A workspace holds one company’s data, people and settings, kept separate from every other workspace. You’ll be its owner."
      />
      <SectionCard title="Workspace details">
        <CreateWorkspaceForm />
      </SectionCard>
    </>
  )
}

import type { Metadata } from 'next'

import { PlannedSection } from '@/modules/app-shell/ui/planned-section'

export const metadata: Metadata = { title: 'Knowledge' }

export default function Page() {
  return <PlannedSection href="/app/knowledge" />
}

import type { Metadata } from 'next'

import { PlannedSection } from '@/modules/app-shell/ui/planned-section'

export const metadata: Metadata = { title: 'Workflows' }

export default function Page() {
  return <PlannedSection href="/app/workflows" />
}

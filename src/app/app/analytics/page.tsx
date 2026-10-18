import type { Metadata } from 'next'

import { PlannedSection } from '@/modules/app-shell/ui/planned-section'

export const metadata: Metadata = { title: 'Analytics' }

export default function Page() {
  return <PlannedSection href="/app/analytics" />
}

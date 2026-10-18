import type { Metadata } from 'next'

import { PlannedSection } from '@/modules/app-shell/ui/planned-section'

export const metadata: Metadata = { title: 'Integrations' }

export default function Page() {
  return <PlannedSection href="/app/integrations" />
}

import type { Metadata } from 'next'

import { PlannedSection } from '@/modules/app-shell/ui/planned-section'

export const metadata: Metadata = { title: 'AI employees' }

export default function Page() {
  return <PlannedSection href="/app/employees" />
}

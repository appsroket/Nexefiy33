// Shown on every page while the workspace's emergency stop is on.

import { OctagonX } from 'lucide-react'
import Link from 'next/link'

import { Alert, AlertDescription } from '@/components/ui/alert'

import { getGovernanceState } from '../server/queries'

export async function EmergencyStopBanner({ organizationId }: { organizationId: string }) {
  let stop: Awaited<ReturnType<typeof getGovernanceState>>['emergencyStop'] = null
  try {
    stop = (await getGovernanceState(organizationId)).emergencyStop
  } catch {
    // The banner is informational; the stop itself is enforced by the database.
    return null
  }
  if (!stop) return null
  return (
    <Alert variant="destructive" role="status">
      <OctagonX aria-hidden="true" />
      <AlertDescription>
        Emergency stop is on: no AI employee or workflow acts until it is lifted. Reason: “{stop.reason}”.{' '}
        <Link href="/app/settings/governance" className="font-medium underline underline-offset-4">
          Governance settings
        </Link>
      </AlertDescription>
    </Alert>
  )
}

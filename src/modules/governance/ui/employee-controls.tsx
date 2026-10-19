'use client'

// On an employee's page: stop it now (operators and above), and revoke one of
// its tools (admins and owners). The database checks both again.

import { OctagonX, ShieldOff } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { FormDialog } from '@/components/forms/form-dialog'
import { TextAreaField } from '@/components/forms/text-field'
import { Button } from '@/components/ui/button'

import { emergencyStopEmployee, revokeEmployeeTool } from '../server/actions'

export function EmployeeEmergencyStop({ employeeId, name }: { employeeId: string; name: string }) {
  const [reason, setReason] = useState('')
  const router = useRouter()
  return (
    <FormDialog
      trigger={
        <Button variant="destructive" size="sm">
          <OctagonX data-icon="inline-start" aria-hidden="true" />
          Stop now
        </Button>
      }
      title={`Stop ${name} now?`}
      description="It is paused, its unfinished tasks pause (a step in progress finishes first), and its actions waiting for approval are withdrawn. An action already running can’t be recalled. An admin can resume it later."
      action={emergencyStopEmployee}
      submitLabel="Stop it"
      pendingLabel="Stopping…"
      onSuccess={() => router.refresh()}
    >
      <input type="hidden" name="employeeId" value={employeeId} />
      <TextAreaField name="reason" label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required />
    </FormDialog>
  )
}

export function RevokeToolButton({ employeeId, toolKey, toolTitle, integrationId }: { employeeId: string; toolKey: string; toolTitle: string; integrationId: string | null }) {
  const router = useRouter()
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm">
          <ShieldOff data-icon="inline-start" aria-hidden="true" />
          Revoke
        </Button>
      }
      title={`Revoke “${toolTitle}”?`}
      description="The employee can’t use it from now on, and its actions waiting on it are cancelled. To give it back, activate a version that grants it."
      confirmLabel="Revoke"
      pendingLabel="Revoking…"
      destructive
      onConfirm={async () => {
        const result = await revokeEmployeeTool(employeeId, toolKey, integrationId)
        if (result.status === 'success') router.refresh()
        return result
      }}
    />
  )
}

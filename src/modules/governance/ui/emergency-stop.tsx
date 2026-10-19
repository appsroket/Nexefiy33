'use client'

// The workspace emergency stop: what it does, its state, and (for admins and
// owners) switching it on with a reason and a typed confirmation, or lifting
// it. The database applies it to every code path; this only asks.

import { OctagonX, Play } from 'lucide-react'
import { useState } from 'react'

import { DateTime } from '@/components/date-time'
import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { FormDialog } from '@/components/forms/form-dialog'
import { TextAreaField, TextField } from '@/components/forms/text-field'
import { StatusIndicator } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

import { EMERGENCY_STOP_CONFIRMATION } from '../domain/controls'
import { liftEmergencyStop, setEmergencyStop } from '../server/actions'

export function EmergencyStopPanel({
  organizationId,
  stop,
  stoppedBy,
  canManage,
}: {
  organizationId: string
  stop: { at: string; reason: string } | null
  stoppedBy: string | null
  canManage: boolean
}) {
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState('')

  if (stop) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 text-sm">
          <StatusIndicator tone="danger" label="Emergency stop is on" />
          <p>
            Switched on <DateTime value={stop.at} />
            {stoppedBy ? ` by ${stoppedBy}` : ''}: “{stop.reason}”
          </p>
          <p className="text-muted-foreground">No AI employee or workflow takes any action, starts a step or gets new work until it is lifted. People can still act themselves.</p>
        </div>
        {canManage ? (
          <ActionForm action={liftEmergencyStop} className="flex flex-col gap-3" aria-label="Lift the emergency stop">
            <input type="hidden" name="organizationId" value={organizationId} />
            <div className="flex items-start gap-2">
              <Checkbox id="resume-tasks" name="resumeTasks" value="on" />
              <Label htmlFor="resume-tasks" className="font-normal">
                Resume the tasks the stop paused (withdrawn approvals are not restored; the employee asks again)
              </Label>
            </div>
            <FormMessage />
            <div>
              <SubmitButton pendingLabel="Lifting…" variant="outline">
                <Play data-icon="inline-start" aria-hidden="true" />
                Lift the emergency stop
              </SubmitButton>
            </div>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted-foreground">Only admins and owners can lift it.</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <StatusIndicator tone="success" label="Off: AI work runs normally" />
      <ul className="list-disc pl-5 text-muted-foreground">
        <li>Every unfinished employee task pauses (a step in progress finishes first).</li>
        <li>Workflow runs are cancelled.</li>
        <li>Actions waiting for approval are withdrawn; approved actions that haven’t started never start.</li>
        <li>Nothing new can be assigned, resumed, approved or started until the stop is lifted.</li>
        <li>An action already running at the provider can’t be recalled and may still complete.</li>
      </ul>
      {canManage ? (
        <div>
          <FormDialog
            trigger={
              <Button variant="destructive">
                <OctagonX data-icon="inline-start" aria-hidden="true" />
                Emergency stop
              </Button>
            }
            title="Stop all AI work in this workspace?"
            description="Everything listed above happens at once. It is recorded in the audit log with your name and reason."
            action={setEmergencyStop}
            submitLabel="Stop all AI work"
            pendingLabel="Stopping…"
          >
            <input type="hidden" name="organizationId" value={organizationId} />
            <TextAreaField name="reason" label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required />
            <TextField
              name="confirm"
              label={`Type ${EMERGENCY_STOP_CONFIRMATION} to confirm`}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="off"
              required
            />
          </FormDialog>
        </div>
      ) : (
        <p className="text-muted-foreground">Only admins and owners can use the emergency stop. Operators can stop a single employee from its page.</p>
      )}
    </div>
  )
}

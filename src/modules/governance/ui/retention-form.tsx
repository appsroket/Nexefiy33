'use client'

// How long task evidence, execution events and action payloads are kept. The
// audit log is separate and kept for at least a year.

import { useState } from 'react'

import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { TextField } from '@/components/forms/text-field'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

import { RETENTION_BOUNDS } from '../domain/controls'
import { saveRetention } from '../server/actions'

const asText = (value: number | null) => (value === null ? '' : String(value))

export function RetentionForm({
  organizationId,
  initial,
  canManage,
}: {
  organizationId: string
  initial: { evidenceDays: number | null; eventDays: number | null; payloadDays: number | null; hold: boolean }
  canManage: boolean
}) {
  const [evidence, setEvidence] = useState(asText(initial.evidenceDays))
  const [events, setEvents] = useState(asText(initial.eventDays))
  const [payloads, setPayloads] = useState(asText(initial.payloadDays))
  const days = { type: 'number', min: RETENTION_BOUNDS.min, max: RETENTION_BOUNDS.max, inputMode: 'numeric' as const, placeholder: 'Keep', disabled: !canManage }
  return (
    <ActionForm action={saveRetention} className="flex flex-col gap-4" aria-label="Evidence retention">
      <input type="hidden" name="organizationId" value={organizationId} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="evidenceDays"
          label="Task evidence (days)"
          description="Cited passages and action results kept with finished tasks."
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
          {...days}
        />
        <TextField name="eventDays" label="Execution events (days)" description="The step-by-step trace of tasks and runs." value={events} onChange={(event) => setEvents(event.target.value)} {...days} />
        <TextField
          name="payloadDays"
          label="Action payloads (days)"
          description="What finished actions sent and received, and approval details. Fingerprints and outcomes stay."
          value={payloads}
          onChange={(event) => setPayloads(event.target.value)}
          {...days}
        />
      </div>
      <div className="flex items-start gap-2">
        <Checkbox id="retention-hold" name="hold" value="on" defaultChecked={initial.hold} disabled={!canManage} />
        <Label htmlFor="retention-hold" className="font-normal">
          Hold: purge nothing (for example during a dispute or an investigation)
        </Label>
      </div>
      {canManage ? (
        <>
          <FormMessage />
          <div>
            <SubmitButton pendingLabel="Saving…" variant="outline">
              Save retention
            </SubmitButton>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Only admins and owners can change retention.</p>
      )}
    </ActionForm>
  )
}

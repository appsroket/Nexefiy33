'use client'

// Human handoff on a task: a person takes it over from the employee (it never
// returns to the employee), then completes or closes it themselves.

import { UserRoundCheck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { FormDialog } from '@/components/forms/form-dialog'
import { SelectField, TextAreaField } from '@/components/forms/text-field'
import { Button } from '@/components/ui/button'

import { completeHandedOffTask, handOffTask } from '../server/actions'

export function TakeOverDialog({ taskId, people, viewerId }: { taskId: string; people: readonly { id: string; name: string }[]; viewerId: string }) {
  const [note, setNote] = useState('')
  const router = useRouter()
  return (
    <FormDialog
      trigger={
        <Button variant="outline">
          <UserRoundCheck data-icon="inline-start" aria-hidden="true" />
          Take over
        </Button>
      }
      title="Hand this task to a person?"
      description="The employee stops working on it for good, and its actions waiting for approval are withdrawn. The person completes it outside Nexefiy and marks it done here."
      action={handOffTask}
      submitLabel="Hand over"
      pendingLabel="Handing over…"
      onSuccess={() => router.refresh()}
    >
      <input type="hidden" name="taskId" value={taskId} />
      <SelectField
        name="assignee"
        label="Who takes it"
        options={people.map((person) => ({ value: person.id, label: person.id === viewerId ? `${person.name} (you)` : person.name }))}
        defaultValue={viewerId}
      />
      <TextAreaField name="note" label="Note (optional)" value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000} />
    </FormDialog>
  )
}

export function CompleteHandoffForm({ taskId }: { taskId: string }) {
  const [note, setNote] = useState('')
  const router = useRouter()
  return (
    <ActionForm action={completeHandedOffTask} className="flex flex-col gap-3" aria-label="Complete the task" onSuccess={() => router.refresh()}>
      <input type="hidden" name="taskId" value={taskId} />
      <SelectField
        name="outcome"
        label="Outcome"
        options={[
          { value: 'done', label: 'Done: I completed it' },
          { value: 'cancelled', label: 'Closed without completing it' },
        ]}
      />
      <TextAreaField name="note" label="What happened (optional)" value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000} />
      <FormMessage />
      <div>
        <SubmitButton pendingLabel="Saving…">Save outcome</SubmitButton>
      </div>
    </ActionForm>
  )
}

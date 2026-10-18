'use client'

// Assigning a task to an active employee, answering an employee that
// escalated, cancelling, and refreshing a page while its task still runs.
// The server and the database check role and state again.

import { Send, Square } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { TextAreaField, TextField } from '@/components/forms/text-field'
import { Button } from '@/components/ui/button'

import { assignTask, cancelTask, replyToTask } from '../server/actions'

export function AssignTaskForm({ employeeId, requestKey }: { employeeId: string; requestKey: string }) {
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  return (
    <ActionForm action={assignTask} className="flex flex-col gap-4" aria-label="Assign a task">
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <TextField
        name="title"
        label="Task"
        placeholder="Check whether jane@example.com is already in HubSpot"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={200}
        required
      />
      <TextAreaField
        name="instructions"
        label="Details (optional)"
        description="Anything the employee needs to know. It works only with its granted tools, within its limits, and asks for approval where its rules say so."
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        rows={4}
      />
      <FormMessage />
      <div>
        <SubmitButton pendingLabel="Assigning…">
          <Send data-icon="inline-start" aria-hidden="true" />
          Assign task
        </SubmitButton>
      </div>
    </ActionForm>
  )
}

export function ReplyForm({ taskId }: { taskId: string }) {
  const [message, setMessage] = useState('')
  return (
    <ActionForm action={replyToTask} className="flex flex-col gap-3" aria-label="Reply to the employee" onSuccess={() => setMessage('')}>
      <input type="hidden" name="taskId" value={taskId} />
      <TextAreaField name="message" label="Your reply" value={message} onChange={(event) => setMessage(event.target.value)} rows={3} required />
      <FormMessage />
      <div>
        <SubmitButton pendingLabel="Sending…">Send reply</SubmitButton>
      </div>
    </ActionForm>
  )
}

export function CancelTaskButton({ taskId }: { taskId: string }) {
  const [message, setMessage] = useState<string | null>(null)
  const router = useRouter()
  return (
    <div className="flex flex-col gap-2">
      <ConfirmDialog
        trigger={
          <Button variant="outline">
            <Square data-icon="inline-start" aria-hidden="true" />
            Cancel task
          </Button>
        }
        title="Cancel this task?"
        description="The employee stops after its current step. Actions waiting for approval are withdrawn; actions that already ran are not undone."
        confirmLabel="Cancel task"
        pendingLabel="Cancelling…"
        destructive
        onConfirm={async () => {
          const result = await cancelTask(taskId)
          if (result.status === 'success') {
            setMessage(result.message ?? null)
            router.refresh()
          }
          return result
        }}
      />
      {message ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  )
}

/** Refreshes the page every few seconds while the task can still change on its own. */
export function AutoRefresh({ active, intervalMs = 4000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs, router])
  return null
}

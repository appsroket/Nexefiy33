'use client'

// Assigning a task to an active employee (priority, dependencies, deadline),
// the controls on a task (cancel, pause, resume, retry, priority, reassign),
// answering an employee that escalated, and refreshing a page while its task
// still runs. The server and the database check role and state again.

import { Pause, Play, RotateCcw, Send, Square } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { SelectField, TextAreaField, TextField } from '@/components/forms/text-field'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { ActionState } from '@/lib/forms/action-state'

import { DEFAULT_TIMEOUT_MINUTES, PRIORITY_OPTIONS, TIMEOUT_OPTIONS, type TaskControls as Controls } from '../domain/task-center'
import { assignTask, cancelTask, pauseTask, reassignTask, replyToTask, resumeTask, retryTask, setTaskPriority } from '../server/actions'

const priorityOptions = PRIORITY_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))
const timeoutOptions = TIMEOUT_OPTIONS.map((option) => ({ value: String(option.value), label: `Within ${option.label}` }))

export function AssignTaskForm({
  employeeId,
  requestKey,
  dependable = [],
}: {
  employeeId: string
  requestKey: string
  dependable?: readonly { id: string; title: string; statusLabel: string }[]
}) {
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
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="priority" label="Priority" options={priorityOptions} defaultValue="0" description="Higher-priority tasks are picked up first." />
        <SelectField
          name="timeoutMinutes"
          label="Deadline"
          options={timeoutOptions}
          defaultValue={String(DEFAULT_TIMEOUT_MINUTES)}
          description="If it isn’t finished by then — including time spent waiting — it fails as timed out."
        />
      </div>
      {dependable.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Start after (optional)</legend>
          <p className="text-sm text-muted-foreground">The task waits until every task you pick has succeeded, and is skipped if one of them doesn’t.</p>
          <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border p-3">
            {dependable.map((task) => (
              <div key={task.id} className="flex items-start gap-2">
                <Checkbox id={`depends-${task.id}`} name="dependsOn" value={task.id} />
                <Label htmlFor={`depends-${task.id}`} className="font-normal">
                  {task.title} <span className="text-muted-foreground">· {task.statusLabel}</span>
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
      ) : null}
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

export interface CancelDisclosure {
  /** Actions that already changed something outside Nexefiy. */
  done: readonly { toolKey: string; id: string }[]
  /** Actions running right now. */
  inProgress: number
  /** Proposed or awaiting approval: withdrawn by cancelling. */
  withdrawn: number
}

function CancelDescription({ disclosure }: { disclosure: CancelDisclosure }) {
  return (
    <span className="flex flex-col gap-2">
      <span>The employee takes no further steps (a step in progress finishes first). Tasks waiting on this one are skipped.</span>
      {disclosure.withdrawn ? (
        <span>
          {disclosure.withdrawn} pending action{disclosure.withdrawn === 1 ? ' is' : 's are'} withdrawn and can no longer be approved.
        </span>
      ) : null}
      {disclosure.done.length ? (
        <span className="font-medium text-foreground">
          Already carried out, and not undone by cancelling: {disclosure.done.map((action) => `${action.toolKey} (receipt ${action.id.slice(0, 8)})`).join(', ')}.
        </span>
      ) : null}
      {disclosure.inProgress ? (
        <span className="font-medium text-foreground">
          {disclosure.inProgress} action{disclosure.inProgress === 1 ? ' is' : 's are'} running right now and can’t be stopped; {disclosure.inProgress === 1 ? 'it' : 'they'} may still complete.
        </span>
      ) : null}
    </span>
  )
}

/** Cancel, pause, resume and retry, as the task's state allows. */
export function TaskControlBar({ taskId, controls, disclosure }: { taskId: string; controls: Controls; disclosure: CancelDisclosure }) {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const after = (result: ActionState) => {
    if (result.status === 'success') {
      setError(null)
      setMessage(result.message ?? null)
      router.refresh()
    } else if (result.status === 'error') {
      setMessage(null)
      setError(result.message)
    }
    return result
  }
  const run = (action: (id: string) => Promise<ActionState>) => () => startTransition(async () => void after(await action(taskId)))

  if (!controls.cancel && !controls.pause && !controls.resume && !controls.retry) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {controls.pause ? (
          <Button variant="outline" onClick={run(pauseTask)} disabled={pending}>
            <Pause data-icon="inline-start" aria-hidden="true" />
            Pause
          </Button>
        ) : null}
        {controls.resume ? (
          <Button variant="outline" onClick={run(resumeTask)} disabled={pending}>
            <Play data-icon="inline-start" aria-hidden="true" />
            Resume
          </Button>
        ) : null}
        {controls.retry ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={pending}>
                <RotateCcw data-icon="inline-start" aria-hidden="true" />
                Retry
              </Button>
            }
            title="Retry this task?"
            description="A new attempt continues from the last checkpoint with a fresh set of step, tool-call, time and cost limits (the monthly budget still applies). Actions that already ran are not repeated."
            confirmLabel="Retry"
            pendingLabel="Retrying…"
            onConfirm={async () => after(await retryTask(taskId))}
          />
        ) : null}
        {controls.cancel ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={pending}>
                <Square data-icon="inline-start" aria-hidden="true" />
                Cancel task
              </Button>
            }
            title="Cancel this task?"
            description={<CancelDescription disclosure={disclosure} />}
            confirmLabel="Cancel task"
            pendingLabel="Cancelling…"
            destructive
            onConfirm={async () => after(await cancelTask(taskId))}
          />
        ) : null}
      </div>
      {message ? (
        <p className="max-w-3xl text-sm text-muted-foreground" aria-live="polite">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function PriorityForm({ taskId, priority }: { taskId: string; priority: number }) {
  const current = PRIORITY_OPTIONS.some((option) => option.value === priority) ? String(priority) : '0'
  return (
    <ActionForm action={setTaskPriority} className="flex flex-col gap-2 sm:w-64" aria-label="Change priority">
      <input type="hidden" name="taskId" value={taskId} />
      <SelectField name="priority" label="Priority" options={priorityOptions} defaultValue={current} />
      <FormMessage />
      <div>
        <SubmitButton pendingLabel="Saving…" variant="outline">
          Change priority
        </SubmitButton>
      </div>
    </ActionForm>
  )
}

export function ReassignForm({ taskId, employees }: { taskId: string; employees: readonly { id: string; name: string }[] }) {
  if (!employees.length) return null
  return (
    <ActionForm action={reassignTask} className="flex flex-col gap-2 sm:w-64" aria-label="Reassign">
      <input type="hidden" name="taskId" value={taskId} />
      <SelectField name="employeeId" label="Reassign to" options={employees.map((employee) => ({ value: employee.id, label: employee.name }))} />
      <FormMessage />
      <div>
        <SubmitButton pendingLabel="Reassigning…" variant="outline">
          Reassign
        </SubmitButton>
      </div>
    </ActionForm>
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

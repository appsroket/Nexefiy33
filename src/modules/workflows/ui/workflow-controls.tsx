'use client'

// Controls around a workflow: its status (pause, resume, archive, restore,
// delete a never-activated draft), restoring a version into the draft,
// starting a run with its inputs, and cancelling a run (which says plainly
// which actions already happened and can't be undone).

import { Archive, CircleAlert, CircleCheck, Pause, Play, RotateCcw, Square, Trash2, Undo2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useActionState, useState, useTransition } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { IDLE_ACTION_STATE, type ActionState } from '@/lib/forms/action-state'

import type { WorkflowInput, WorkflowStatus } from '../domain/types'
import { cancelRunAction, changeWorkflowStatusAction, deleteWorkflowAction, restoreVersionAction, startRunAction } from '../server/actions'

function Result({ result }: { result: ActionState | null }) {
  if (!result || result.status === 'idle') return null
  return (
    <Alert variant={result.status === 'error' ? 'destructive' : 'default'} role={result.status === 'error' ? 'alert' : 'status'}>
      {result.status === 'error' ? <CircleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
      <AlertDescription>{result.message}</AlertDescription>
    </Alert>
  )
}

export function WorkflowStatusControls({
  organizationId,
  workflowId,
  status,
  everActivated,
  canOperate,
  canAdminister,
}: {
  organizationId: string
  workflowId: string
  status: WorkflowStatus
  everActivated: boolean
  canOperate: boolean
  canAdminister: boolean
}) {
  const router = useRouter()
  const [result, setResult] = useState<ActionState | null>(null)
  const [pending, startTransition] = useTransition()
  const run = (action: 'pause' | 'resume' | 'archive' | 'restore') =>
    startTransition(async () => {
      const outcome = await changeWorkflowStatusAction(workflowId, action)
      setResult(outcome)
      router.refresh()
    })
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {status === 'active' && canOperate ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run('pause')}>
            <Pause data-icon="inline-start" aria-hidden="true" />
            Pause
          </Button>
        ) : null}
        {status === 'paused' && canAdminister ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run('resume')}>
            <Play data-icon="inline-start" aria-hidden="true" />
            Resume
          </Button>
        ) : null}
        {status !== 'archived' && everActivated && canAdminister ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline" size="sm">
                <Archive data-icon="inline-start" aria-hidden="true" />
                Archive
              </Button>
            }
            title="Archive this workflow?"
            description="No new runs start and its schedule stops. Runs already going continue. Its versions and run history are kept, and you can restore it later."
            confirmLabel="Archive"
            onConfirm={async () => {
              const outcome = await changeWorkflowStatusAction(workflowId, 'archive')
              if (outcome.status === 'success') router.refresh()
              return outcome
            }}
          />
        ) : null}
        {status === 'archived' && canAdminister ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run('restore')}>
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
            Restore
          </Button>
        ) : null}
        {!everActivated && canOperate ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="destructive" size="sm">
                <Trash2 data-icon="inline-start" aria-hidden="true" />
                Delete draft
              </Button>
            }
            title="Delete this draft?"
            description="It was never activated, so nothing else depends on it. This can’t be undone."
            confirmLabel="Delete"
            destructive
            onConfirm={() => deleteWorkflowAction(organizationId, workflowId)}
          />
        ) : null}
      </div>
      <Result result={result} />
    </div>
  )
}

export function RestoreVersionButton({ organizationId, workflowId, versionId, version, lockVersion }: { organizationId: string; workflowId: string; versionId: string; version: number; lockVersion: number }) {
  const router = useRouter()
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="ghost" size="sm">
          <Undo2 data-icon="inline-start" aria-hidden="true" />
          Restore into draft
        </Button>
      }
      title={`Restore version ${version} into the draft?`}
      description="The draft is replaced by this version’s steps (save your current draft first if you want to keep it). Nothing changes for runs until an admin activates the draft as a new version."
      confirmLabel="Restore"
      onConfirm={async () => {
        const outcome = await restoreVersionAction({ organizationId, workflowId, versionId, lockVersion })
        if (outcome.status === 'saved') {
          router.refresh()
          return { status: 'success' as const }
        }
        return { status: 'error' as const, message: outcome.message }
      }}
    />
  )
}

export function StartRunForm({ organizationId, workflowId, inputs, requestKey }: { organizationId: string; workflowId: string; inputs: WorkflowInput[]; requestKey: string }) {
  const [state, formAction, pending] = useActionState(startRunAction, IDLE_ACTION_STATE)
  const fieldErrors = state.status === 'error' ? (state.fieldErrors ?? {}) : {}
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="workflowId" value={workflowId} />
      <input type="hidden" name="requestKey" value={requestKey} />
      {inputs.map((input) => {
        const name = `input.${input.key}`
        const errors = fieldErrors[name]
        return (
          <Field key={input.key} data-invalid={errors ? true : undefined}>
            {input.type === 'boolean' ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name={name} />
                {input.label}
              </label>
            ) : (
              <>
                <FieldLabel htmlFor={`run-${input.key}`}>
                  {input.label}
                  {input.required ? '' : ' (optional)'}
                </FieldLabel>
                {input.type === 'long_text' ? (
                  <Textarea id={`run-${input.key}`} name={name} rows={3} maxLength={5000} required={input.required} />
                ) : (
                  <Input id={`run-${input.key}`} name={name} type={input.type === 'number' ? 'number' : input.type === 'email' ? 'email' : 'text'} required={input.required} maxLength={input.type === 'email' ? 254 : 500} />
                )}
              </>
            )}
            {input.description ? <FieldDescription>{input.description}</FieldDescription> : null}
            {errors ? <FieldError>{errors.join(' ')}</FieldError> : null}
          </Field>
        )
      })}
      {state.status === 'error' ? <Result result={state} /> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Play data-icon="inline-start" aria-hidden="true" />}
          Start a run
        </Button>
      </div>
    </form>
  )
}

export function CancelRunButton({ runId, completedChanges, inProgress }: { runId: string; completedChanges: string[]; inProgress: number }) {
  const router = useRouter()
  const [result, setResult] = useState<ActionState | null>(null)
  return (
    <div className="flex flex-col gap-2">
      <ConfirmDialog
        trigger={
          <Button type="button" variant="destructive" size="sm">
            <Square data-icon="inline-start" aria-hidden="true" />
            Cancel run
          </Button>
        }
        title="Cancel this run?"
        description={
          <>
            No further steps start, pending approvals are withdrawn, and a step an employee is working on stops after its current step.
            {completedChanges.length ? ` Already carried out and not undone by cancelling: ${completedChanges.join(', ')}.` : ' No change to another app has been carried out yet.'}
            {inProgress ? ` ${inProgress} action(s) are running right now and may still complete.` : ''}
          </>
        }
        confirmLabel="Cancel run"
        destructive
        onConfirm={async () => {
          const outcome = await cancelRunAction(runId)
          setResult(outcome)
          if (outcome.status === 'success') router.refresh()
          return outcome
        }}
      />
      <Result result={result} />
    </div>
  )
}

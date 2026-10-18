'use client'

// Status controls: start testing, activate (with a confirmation that shows
// exactly what the employee will be allowed to do and asks for its name),
// pause, resume, archive, restore, and deleting a never-activated draft.
// The server and the database check role, state and test results again.

import { CircleAlert, CircleCheck, Pause, Play, Power, RotateCcw, Archive, FlaskConical, Undo2, Trash2 } from 'lucide-react'
import { useState, useTransition } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import type { ActionState } from '@/lib/forms/action-state'

import { ACTION_LABELS, type LifecycleAction } from '../domain/lifecycle'
import { changeEmployeeStatus, deleteEmployeeDraft } from '../server/actions'

export interface ActivationSummary {
  version: number
  versionId: string
  modelLabel: string
  tools: { title: string; approval: string }[]
  knowledge: string
  limits: string
  budget: string
}

const ICONS: Record<LifecycleAction, typeof Play> = {
  start_testing: FlaskConical,
  return_to_draft: Undo2,
  activate: Power,
  pause: Pause,
  resume: Play,
  archive: Archive,
  restore: RotateCcw,
}

export function LifecycleControls({
  organizationId,
  employeeId,
  employeeName,
  actions,
  activation,
  canDelete,
}: {
  organizationId: string
  employeeId: string
  employeeName: string
  actions: LifecycleAction[]
  activation: ActivationSummary | null
  canDelete: boolean
}) {
  const [result, setResult] = useState<ActionState | null>(null)
  const [pending, startTransition] = useTransition()

  function run(action: LifecycleAction) {
    setResult(null)
    startTransition(async () => setResult(await changeEmployeeStatus(organizationId, employeeId, action)))
  }

  const simple = actions.filter((action) => action !== 'activate' && action !== 'archive')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {actions.includes('activate') && activation ? (
          <ActivateDialog organizationId={organizationId} employeeId={employeeId} employeeName={employeeName} summary={activation} onResult={setResult} />
        ) : null}
        {simple.map((action) => {
          const Icon = ICONS[action]
          return (
            <Button key={action} variant={action === 'pause' ? 'destructive' : 'outline'} disabled={pending} onClick={() => run(action)}>
              {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Icon data-icon="inline-start" aria-hidden="true" />}
              {ACTION_LABELS[action]}
            </Button>
          )
        })}
        {actions.includes('archive') ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={pending}>
                <Archive data-icon="inline-start" aria-hidden="true" />
                Archive
              </Button>
            }
            title={`Archive ${employeeName}?`}
            description="It stops running and can’t be edited. Its versions, test runs and history are kept, and an admin can restore it as a draft."
            confirmLabel="Archive"
            destructive
            onConfirm={async () => {
              const outcome = await changeEmployeeStatus(organizationId, employeeId, 'archive')
              setResult(outcome)
              return outcome
            }}
          />
        ) : null}
        {canDelete ? (
          <ConfirmDialog
            trigger={
              <Button variant="ghost" disabled={pending}>
                <Trash2 data-icon="inline-start" aria-hidden="true" />
                Delete draft
              </Button>
            }
            title={`Delete ${employeeName}?`}
            description="This draft was never activated, so it can be deleted with its versions, test cases and test runs. This can’t be undone."
            confirmLabel="Delete"
            destructive
            onConfirm={() => deleteEmployeeDraft(organizationId, employeeId)}
          />
        ) : null}
      </div>
      <div aria-live="polite">
        {result ? (
          <Alert variant={result.status === 'error' ? 'destructive' : 'default'} role={result.status === 'error' ? 'alert' : 'status'}>
            {result.status === 'error' ? <CircleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
            <AlertDescription>{result.status === 'error' ? result.message : result.status === 'success' ? result.message : null}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  )
}

function ActivateDialog({
  organizationId,
  employeeId,
  employeeName,
  summary,
  onResult,
}: {
  organizationId: string
  employeeId: string
  employeeName: string
  summary: ActivationSummary
  onResult: (result: ActionState) => void
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const matches = typed.trim().toLowerCase() === employeeName.trim().toLowerCase()

  function activate() {
    setError(null)
    startTransition(async () => {
      const outcome = await changeEmployeeStatus(organizationId, employeeId, 'activate', { versionId: summary.versionId, confirmName: typed })
      if (outcome.status === 'error') setError(outcome.message)
      else {
        setOpen(false)
        setTyped('')
        onResult(outcome)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        setOpen(next)
        if (!next) {
          setError(null)
          setTyped('')
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Power data-icon="inline-start" aria-hidden="true" />
          Activate version {summary.version}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Activate {employeeName}?</DialogTitle>
          <DialogDescription>Version {summary.version} passed its tests. Once active, it can be given real work with exactly these permissions.</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Model</dt>
          <dd>{summary.modelLabel}</dd>
          <dt className="text-muted-foreground">Tools</dt>
          <dd>
            {summary.tools.length ? (
              <ul className="list-disc pl-4">
                {summary.tools.map((tool) => (
                  <li key={tool.title}>
                    {tool.title}: {tool.approval}
                  </li>
                ))}
              </ul>
            ) : (
              'None'
            )}
          </dd>
          <dt className="text-muted-foreground">Knowledge</dt>
          <dd>{summary.knowledge}</dd>
          <dt className="text-muted-foreground">Limits</dt>
          <dd>{summary.limits}</dd>
          <dt className="text-muted-foreground">Budget</dt>
          <dd>{summary.budget}</dd>
        </dl>
        <Field>
          <FieldLabel htmlFor="activate-confirm">Type “{employeeName}” to confirm</FieldLabel>
          <Input id="activate-confirm" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          <FieldDescription>Activation is recorded in the audit log with your name and the version number.</FieldDescription>
        </Field>
        {error ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={activate} disabled={pending || !matches}>
            {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Power data-icon="inline-start" aria-hidden="true" />}
            Activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

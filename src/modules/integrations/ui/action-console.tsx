'use client'

// Test console: runs one action against the connected account, through the
// same server-side checks, policies and approvals an AI employee would face.
// Results are real provider responses — nothing here is simulated.

import { CircleAlert, CircleCheck, Clock, Play, ShieldX } from 'lucide-react'
import Link from 'next/link'
import { useActionState, useMemo, useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'

import { runIntegrationAction, type ActionRunState } from '../server/actions'
import { APPROVAL_MODE_LABELS, type ActionSummary } from '../domain/types'

const IDLE: ActionRunState = { status: 'idle' }

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function ActionConsole({
  organizationId,
  integrationId,
  actions,
  approvalModes,
}: {
  organizationId: string
  integrationId: string
  actions: ActionSummary[]
  approvalModes: Record<string, string>
}) {
  const [state, formAction, pending] = useActionState(runIntegrationAction, IDLE)
  const [actionKey, setActionKey] = useState(actions[0]?.key ?? '')
  const selected = useMemo(() => actions.find((action) => action.key === actionKey), [actions, actionKey])
  const [input, setInput] = useState(() => pretty(actions[0]?.exampleInput ?? {}))
  // One key per submission, sent with the form: if the same submission reaches the server twice, the action runs once.
  // A new key is prepared after each submit (the submitted form data already holds the old one).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} onSubmit={() => setIdempotencyKey(crypto.randomUUID())} className="flex flex-col gap-3" aria-label="Run an action">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="integrationId" value={integrationId} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <Field>
          <FieldLabel htmlFor="console-action">Action</FieldLabel>
          <select
            id="console-action"
            name="actionKey"
            value={actionKey}
            onChange={(event) => {
              setActionKey(event.target.value)
              setInput(pretty(actions.find((action) => action.key === event.target.value)?.exampleInput ?? {}))
            }}
            className={SELECT_CLASS}
          >
            {actions.map((action) => (
              <option key={action.key} value={action.key}>
                {action.title} ({action.key})
              </option>
            ))}
          </select>
          {selected ? (
            <FieldDescription>
              {selected.description} {approvalModes[selected.key] ? `Currently: ${approvalModes[selected.key]}.` : `Currently: ${APPROVAL_MODE_LABELS[selected.defaultApprovalMode]}.`}
            </FieldDescription>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="console-input">Input (JSON)</FieldLabel>
          <Textarea
            id="console-input"
            name="input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={8}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <FieldDescription>The example is a starting point; replace it with real values from your test account.</FieldDescription>
        </Field>
        <div>
          <Button type="submit" disabled={pending || !selected}>
            {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Play data-icon="inline-start" aria-hidden="true" />}
            Run action
          </Button>
        </div>
      </form>

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.status === 'error' ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{state.message}</AlertTitle>
            {state.issues?.length ? (
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {state.issues.map((issue) => (
                    <li key={`${issue.path}:${issue.message}`}>
                      {issue.path ? <code>{issue.path}</code> : null} {issue.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            ) : null}
          </Alert>
        ) : null}
        {state.status === 'done' ? (
          <Alert variant={state.outcome === 'failed' || state.outcome === 'denied' ? 'destructive' : 'default'} role="status">
            {state.outcome === 'succeeded' ? (
              <CircleCheck aria-hidden="true" />
            ) : state.outcome === 'awaiting_approval' ? (
              <Clock aria-hidden="true" />
            ) : state.outcome === 'denied' ? (
              <ShieldX aria-hidden="true" />
            ) : (
              <CircleAlert aria-hidden="true" />
            )}
            <AlertTitle>{state.message}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              {state.outcome === 'awaiting_approval' ? <Link href="/app/approvals" className="underline">Open Approvals</Link> : null}
              {state.error?.providerCode ? <span>Provider code: {state.error.providerCode}</span> : null}
              {state.output !== undefined && state.output !== null ? (
                <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{pretty(state.output)}</pre>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  )
}

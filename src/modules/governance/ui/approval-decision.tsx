'use client'

// Approve / reject form. Sends the payload fingerprint the approver is
// looking at, so a decision can't apply to an action that changed since.

import { Check, CircleAlert, CircleCheck, X } from 'lucide-react'
import { useActionState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { IDLE_ACTION_STATE } from '@/lib/forms/action-state'

import { decideApproval } from '../server/approval-actions'

export function ApprovalDecision({ requestId, payloadSha256 }: { requestId: string; payloadSha256: string }) {
  const [state, action, pending] = useActionState(decideApproval, IDLE_ACTION_STATE)

  if (state.status === 'success') {
    return (
      <Alert role="status">
        <CircleCheck aria-hidden="true" />
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <form action={action} className="flex flex-col gap-3" aria-label="Decide this request">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="payloadSha256" value={payloadSha256} />
      <Field>
        <FieldLabel htmlFor="decision-note">Note (optional)</FieldLabel>
        <Textarea id="decision-note" name="note" maxLength={2000} rows={2} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="approved" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Check data-icon="inline-start" aria-hidden="true" />}
          Approve and run
        </Button>
        <Button type="submit" name="decision" value="rejected" variant="outline" disabled={pending}>
          <X data-icon="inline-start" aria-hidden="true" />
          Reject
        </Button>
      </div>
      {state.status === 'error' ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  )
}

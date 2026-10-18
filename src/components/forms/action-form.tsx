'use client'

import { CircleAlert, CircleCheck } from 'lucide-react'
import { createContext, useActionState, useContext, useEffect, useRef, type ReactNode } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { IDLE_ACTION_STATE, type ActionState } from '@/lib/forms/action-state'

export type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>

interface ActionFormContextValue {
  state: ActionState
  pending: boolean
}

const ActionFormContext = createContext<ActionFormContextValue>({ state: IDLE_ACTION_STATE, pending: false })

export function useActionFormState(): ActionFormContextValue {
  return useContext(ActionFormContext)
}

/**
 * A form bound to a Server Action via useActionState. The action validates on
 * the server and returns an ActionState; field errors, the form message, and
 * the pending state are shared with the controls below through context.
 * Works without JavaScript (progressive enhancement).
 */
export function ActionForm({
  action,
  onSuccess,
  onResult,
  children,
  className,
  'aria-label': ariaLabel,
}: {
  action: FormAction
  onSuccess?: (state: ActionState) => void
  /** Called after every submission, successful or not. */
  onResult?: (state: ActionState) => void
  children: ReactNode
  className?: string
  'aria-label'?: string
}) {
  const [state, formAction, pending] = useActionState(action, IDLE_ACTION_STATE)
  const formRef = useRef<HTMLFormElement>(null)
  const handled = useRef<ActionState>(IDLE_ACTION_STATE)

  useEffect(() => {
    if (state === handled.current) return
    handled.current = state
    onResult?.(state)
    if (state.status === 'success') onSuccess?.(state)
    // Move focus to the first invalid field so keyboard and screen-reader users land on the problem.
    if (state.status === 'error') formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [state, onSuccess, onResult])

  return (
    <ActionFormContext value={{ state, pending }}>
      <form ref={formRef} action={formAction} aria-label={ariaLabel} noValidate className={className}>
        {children}
      </form>
    </ActionFormContext>
  )
}

/** Field-level messages for `name`, announced when they appear. */
export function FieldErrors({ name }: { name: string }) {
  const { state } = useActionFormState()
  const messages = state.status === 'error' ? state.fieldErrors?.[name] : undefined
  if (!messages?.length) return null
  return <FieldError id={fieldErrorId(name)} errors={messages.map((message) => ({ message }))} />
}

export function fieldErrorId(name: string): string {
  return `field-error-${name}`
}

/** Props for an input so it reports invalid state and points at its error text. */
export function useFieldA11y(name: string): { 'aria-invalid': boolean; 'aria-describedby'?: string } {
  const { state } = useActionFormState()
  const invalid = state.status === 'error' && Boolean(state.fieldErrors?.[name]?.length)
  return invalid ? { 'aria-invalid': true, 'aria-describedby': fieldErrorId(name) } : { 'aria-invalid': false }
}

/** Overall result of the last submission. */
export function FormMessage({ successFallback }: { successFallback?: string }) {
  const { state } = useActionFormState()
  if (state.status === 'error') {
    return (
      <Alert variant="destructive" role="alert">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    )
  }
  const successText = state.status === 'success' ? (state.message ?? successFallback) : undefined
  return (
    <div aria-live="polite">
      {successText ? (
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertDescription>{successText}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

export function SubmitButton({
  children,
  pendingLabel = 'Saving…',
  variant,
}: {
  children: ReactNode
  pendingLabel?: string
  variant?: 'default' | 'destructive' | 'outline' | 'secondary'
}) {
  const { pending } = useActionFormState()
  return (
    <Button type="submit" variant={variant} disabled={pending} aria-disabled={pending}>
      {pending ? (
        <>
          <Spinner data-icon="inline-start" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  )
}

// Result shape for Server Actions used with useActionState. Expected failures
// (validation, permission, not found) are returned, not thrown, so forms can
// show them inline; unexpected errors are thrown and reach an error boundary.
//
// Free of Zod because client components import it; the Zod helpers for
// parsing form data on the server are in parse-form.ts.

export type FieldErrors = Partial<Record<string, string[]>>

export type ActionState =
  | { status: 'idle' }
  /** `data`: small values the form needs afterwards, e.g. a link to show once. */
  | { status: 'success'; message?: string; data?: Record<string, string> }
  /** `code`: a stable reason the form can react to, e.g. offering to resend an email. */
  | { status: 'error'; message: string; fieldErrors?: FieldErrors; code?: string }

export const IDLE_ACTION_STATE: ActionState = { status: 'idle' }

export function actionSuccess(message?: string, data?: Record<string, string>): ActionState {
  return {
    status: 'success',
    ...(message === undefined ? {} : { message }),
    ...(data === undefined ? {} : { data }),
  }
}

export function actionError(message: string, fieldErrors?: FieldErrors, code?: string): ActionState {
  return {
    status: 'error',
    message,
    ...(fieldErrors === undefined ? {} : { fieldErrors }),
    ...(code === undefined ? {} : { code }),
  }
}

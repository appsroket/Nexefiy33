// Server-side form parsing with Zod. Kept apart from action-state.ts so that
// client components importing the ActionState type and helpers don't pull Zod
// into the browser bundle.

import { z } from 'zod'

import { actionError, type ActionState, type FieldErrors } from './action-state'

/** Maps a Zod error to per-field messages. Errors without a path go under "_form". */
export function fieldErrorsFromZod(error: z.ZodError): FieldErrors {
  const flattened = z.flattenError(error)
  const result: FieldErrors = { ...(flattened.fieldErrors as FieldErrors) }
  if (flattened.formErrors.length) result._form = flattened.formErrors
  return result
}

/** Parses FormData with a Zod schema into either data or a ready-to-return ActionState. */
export function parseFormData<T extends z.ZodType>(
  schema: T,
  formData: FormData,
): { ok: true; data: z.infer<T> } | { ok: false; state: ActionState } {
  const result = schema.safeParse(Object.fromEntries(formData))
  if (result.success) return { ok: true, data: result.data }
  return { ok: false, state: actionError('Please correct the highlighted fields.', fieldErrorsFromZod(result.error)) }
}

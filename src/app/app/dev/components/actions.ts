'use server'

// Example actions for the development component gallery. They validate input
// and return results but never store or send anything. Server Actions remain
// callable endpoints in every build, so each one refuses to run in production.

import { z } from 'zod'

import { getServerEnv } from '@/lib/env/server'
import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { parseFormData } from '@/lib/forms/parse-form'

function blockedInProduction(): ActionState | null {
  return getServerEnv().appEnv === 'production' ? actionError('Not available.') : null
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const exampleSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(80, 'Use 80 characters or fewer.'),
  email: z.email('Enter a valid email address.'),
})

export async function exampleFormAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const blocked = blockedInProduction()
  if (blocked) return blocked
  await pause(500)
  const parsed = parseFormData(exampleSchema, formData)
  if (!parsed.ok) return parsed.state
  return actionSuccess(`Example only: “${parsed.data.name}” passed validation. Nothing was saved.`)
}

export async function exampleConfirmAction(): Promise<ActionState> {
  const blocked = blockedInProduction()
  if (blocked) return blocked
  await pause(600)
  return actionSuccess()
}

export async function exampleFailingConfirmAction(): Promise<ActionState> {
  const blocked = blockedInProduction()
  if (blocked) return blocked
  await pause(600)
  return actionError('Example failure: the action was refused. Nothing was changed.')
}

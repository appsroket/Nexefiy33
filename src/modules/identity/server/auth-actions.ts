'use server'

// Sign-up, sign-in, email confirmation, password reset and sign-out.
//
// Supabase Auth owns passwords and sessions; these actions validate input,
// apply a per-address rate limit, and translate errors into plain language.
// Never log emails, passwords, tokens or codes: failures log only the Auth
// error code and HTTP status.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { getServerEnv } from '@/lib/env/server'
import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { parseFormData } from '@/lib/forms/parse-form'
import { createRateLimiter } from '@/lib/rate-limit'
import { clientAddress } from '@/lib/request'
import { createUserClient } from '@/lib/supabase/server'
import { forgetWorkspace } from '@/modules/app-shell/server/workspace-cookie'

import { AUTH_PATHS, authCallbackUrl, authErrorMessage, safeNextPath } from '../domain/auth'
import {
  changePasswordSchema,
  emailOnlySchema,
  newPasswordSchema,
  profileSchema,
  signInSchema,
  signUpSchema,
} from '../domain/schemas'
import { getVerifiedUser, SESSION_ENDED_MESSAGE } from './session'

// Per server instance; Supabase Auth applies its own limits as well.
const limits = {
  signIn: createRateLimiter({ limit: 10, windowMs: 5 * 60_000 }),
  signUp: createRateLimiter({ limit: 5, windowMs: 60 * 60_000 }),
  email: createRateLimiter({ limit: 5, windowMs: 15 * 60_000 }),
}

const TOO_MANY_ATTEMPTS = 'Too many attempts. Please wait a few minutes and try again.'

function logAuthFailure(action: string, error: { code?: string; status?: number }) {
  console.error(`[identity] ${action} failed`, { code: error.code ?? 'unknown', status: error.status ?? 0 })
}

function appUrl(): string {
  return getServerEnv().core.appUrl
}

export async function signIn(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseFormData(signInSchema, formData)
  if (!parsed.ok) return parsed.state
  if (!limits.signIn(await clientAddress())) return actionError(TOO_MANY_ATTEMPTS)

  const supabase = await createUserClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)
  if (error) {
    if (error.code !== 'invalid_credentials' && error.code !== 'email_not_confirmed') logAuthFailure('sign-in', error)
    return actionError(authErrorMessage(error.code), undefined, error.code)
  }

  revalidatePath('/app', 'layout')
  redirect(safeNextPath(formData.get('next')))
}

export async function signUp(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseFormData(signUpSchema, formData)
  if (!parsed.ok) return parsed.state
  if (!limits.signUp(await clientAddress())) return actionError(TOO_MANY_ATTEMPTS)

  const next = safeNextPath(formData.get('next'))
  const { email, password, fullName } = parsed.data
  const supabase = await createUserClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: authCallbackUrl(appUrl(), next), data: { full_name: fullName } },
  })
  if (error) {
    if (error.code === 'weak_password') {
      return actionError('Please correct the highlighted fields.', { password: [authErrorMessage(error.code)] })
    }
    logAuthFailure('sign-up', error)
    return actionError(authErrorMessage(error.code), undefined, error.code)
  }

  // Email confirmation turned off for this project: the account is ready now.
  if (data.session) {
    revalidatePath('/app', 'layout')
    redirect(next)
  }
  // With confirmation on, Supabase answers the same way for new and existing
  // addresses, so this message never reveals whether an account exists.
  return actionSuccess(`We sent a confirmation link to ${email}. Open it in this browser to finish creating your account.`, {
    email,
  })
}

export async function resendConfirmation(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseFormData(emailOnlySchema, formData)
  if (!parsed.ok) return parsed.state
  if (!limits.email(await clientAddress())) return actionError(TOO_MANY_ATTEMPTS)

  const supabase = await createUserClient()
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: parsed.data.email,
    options: { emailRedirectTo: authCallbackUrl(appUrl(), safeNextPath(formData.get('next'))) },
  })
  if (error) {
    if (error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') {
      return actionError(authErrorMessage(error.code))
    }
    logAuthFailure('confirmation resend', error)
  }
  return actionSuccess('If that address is waiting for confirmation, we’ve sent a new link.')
}

export async function requestPasswordReset(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseFormData(emailOnlySchema, formData)
  if (!parsed.ok) return parsed.state
  if (!limits.email(await clientAddress())) return actionError(TOO_MANY_ATTEMPTS)

  const supabase = await createUserClient()
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: authCallbackUrl(appUrl(), AUTH_PATHS.resetPassword),
  })
  if (error) {
    if (error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') {
      return actionError(authErrorMessage(error.code))
    }
    logAuthFailure('password reset request', error)
    return actionError('We couldn’t send the email just now. Please try again in a few minutes.')
  }
  // The same answer whether or not an account exists for the address.
  return actionSuccess(
    `If there’s an account for ${parsed.data.email}, we’ve sent it a link to choose a new password. Open it in this browser; it works once.`,
  )
}

/** Sets a new password after following a reset link (the link signs the person in). */
export async function resetPassword(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseFormData(newPasswordSchema, formData)
  if (!parsed.ok) return parsed.state

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) {
    return actionError('This reset link has expired. Ask for a new one.', undefined, 'session_ended')
  }
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
  if (error) {
    if (error.code === 'weak_password' || error.code === 'same_password') {
      return actionError('Please correct the highlighted fields.', { password: [authErrorMessage(error.code)] })
    }
    logAuthFailure('password reset', error)
    return actionError(authErrorMessage(error.code))
  }
  await endOtherSessions(supabase)
  revalidatePath('/app', 'layout')
  redirect('/app')
}

/** Changes the password from account settings; the current password is required. */
export async function changePassword(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseFormData(changePasswordSchema, formData)
  if (!parsed.ok) return parsed.state
  if (!limits.signIn(await clientAddress())) return actionError(TOO_MANY_ATTEMPTS)

  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  if (!user?.email) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  // Confirms the person at the keyboard knows the current password.
  const check = await supabase.auth.signInWithPassword({ email: user.email, password: parsed.data.currentPassword })
  if (check.error) {
    if (check.error.code === 'invalid_credentials') {
      return actionError('Please correct the highlighted fields.', { currentPassword: ['That isn’t your current password.'] })
    }
    logAuthFailure('password check', check.error)
    return actionError(authErrorMessage(check.error.code))
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
  if (error) {
    if (error.code === 'weak_password' || error.code === 'same_password') {
      return actionError('Please correct the highlighted fields.', { password: [authErrorMessage(error.code)] })
    }
    logAuthFailure('password change', error)
    return actionError(authErrorMessage(error.code))
  }
  await endOtherSessions(supabase)
  return actionSuccess('Password changed. You’ve been signed out on your other devices.')
}

async function endOtherSessions(supabase: Awaited<ReturnType<typeof createUserClient>>) {
  const { error } = await supabase.auth.signOut({ scope: 'others' })
  if (error) logAuthFailure('signing out other sessions', error)
}

/** Ends every session for this account, on all devices. */
export async function signOutEverywhere(_previous: ActionState, _formData: FormData): Promise<ActionState> {
  const supabase = await createUserClient()
  const { error } = await supabase.auth.signOut({ scope: 'global' })
  if (error) {
    logAuthFailure('global sign-out', error)
    return actionError('We couldn’t sign you out everywhere. Please try again.')
  }
  await forgetWorkspace()
  redirect('/sign-in?signed_out=1')
}

/** Signs out on this device and returns to sign-in, then back to the invitation. */
export async function switchAccount(): Promise<void> {
  const supabase = await createUserClient()
  const { error } = await supabase.auth.signOut({ scope: 'local' })
  if (error) logAuthFailure('sign-out', error)
  await forgetWorkspace()
  redirect(`${AUTH_PATHS.signIn}?next=${AUTH_PATHS.invite}`)
}

export async function updateProfile(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseFormData(profileSchema, formData)
  if (!parsed.ok) return parsed.state

  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  if (!user) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase
    .from('profiles')
    .update({ full_name: parsed.data.fullName })
    .eq('id', user.id)
    .select('id')
  if (error || data.length === 0) {
    console.error('[identity] profile update failed', { code: error?.code ?? 'no_rows' })
    return actionError('We couldn’t save your profile. Please try again.')
  }
  revalidatePath('/app', 'layout')
  return actionSuccess('Profile saved.')
}

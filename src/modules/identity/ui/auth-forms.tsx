'use client'

// Sign-in, sign-up and password forms. Validation and every decision happen
// in the Server Actions; these components only collect input and show results.

import { MailCheck } from 'lucide-react'
import { useState } from 'react'

import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { TextField } from '@/components/forms/text-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { FieldGroup } from '@/components/ui/field'

import { AUTH_PATHS, PASSWORD_LIMITS } from '../domain/auth'
import {
  requestPasswordReset,
  resendConfirmation,
  resetPassword,
  signIn,
  signUp,
} from '../server/auth-actions'
import { InlineLink } from './auth-card'

const PASSWORD_HINT = `At least ${PASSWORD_LIMITS.minLength} characters.`

export function SignInForm({ next, notice }: { next: string; notice: string | null }) {
  const [email, setEmail] = useState('')
  const [resend, setResend] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      <ActionForm
        action={signIn}
        aria-label="Sign in"
        className="flex flex-col gap-4"
        // Offer to resend the confirmation email after "email not confirmed".
        onResult={(state) => setResend(state.status === 'error' && state.code === 'email_not_confirmed')}
      >
        <FormMessage />
        <input type="hidden" name="next" value={next} />
        <FieldGroup>
          <TextField
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <TextField
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            labelAction={<InlineLink href={AUTH_PATHS.forgotPassword}>Forgot password?</InlineLink>}
          />
        </FieldGroup>
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      {resend ? <ResendConfirmationForm email={email} next={next} /> : null}
    </div>
  )
}

export function ResendConfirmationForm({ email, next }: { email: string; next: string }) {
  return (
    <ActionForm action={resendConfirmation} aria-label="Resend confirmation email" className="flex flex-col gap-3">
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="next" value={next} />
      <FormMessage />
      <div>
        <SubmitButton variant="outline" pendingLabel="Sending…">
          Send the confirmation email again
        </SubmitButton>
      </div>
    </ActionForm>
  )
}

export function SignUpForm({ next }: { next: string }) {
  const [values, setValues] = useState({ fullName: '', email: '' })
  const [sentTo, setSentTo] = useState<string | null>(null)

  if (sentTo) {
    return (
      <div className="flex flex-col gap-4" role="status">
        <Alert>
          <MailCheck aria-hidden="true" />
          <AlertTitle>Check your email</AlertTitle>
          <AlertDescription>
            We sent a confirmation link to {sentTo}. Open it in this browser to finish creating your account. It can take a
            minute to arrive; check your spam folder too.
          </AlertDescription>
        </Alert>
        <ResendConfirmationForm email={sentTo} next={next} />
      </div>
    )
  }

  return (
    <ActionForm
      action={signUp}
      aria-label="Create an account"
      className="flex flex-col gap-4"
      onSuccess={(state) => {
        if (state.status === 'success' && state.data?.email) setSentTo(state.data.email)
      }}
    >
      <FormMessage />
      <input type="hidden" name="next" value={next} />
      <FieldGroup>
        <TextField
          name="fullName"
          label="Your name"
          autoComplete="name"
          required
          maxLength={200}
          value={values.fullName}
          onChange={(event) => setValues((current) => ({ ...current, fullName: event.target.value }))}
        />
        <TextField
          name="email"
          label="Work email"
          type="email"
          autoComplete="email"
          required
          value={values.email}
          onChange={(event) => setValues((current) => ({ ...current, email: event.target.value }))}
        />
        <TextField
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_LIMITS.minLength}
          description={PASSWORD_HINT}
        />
      </FieldGroup>
      <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
    </ActionForm>
  )
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  return (
    <ActionForm action={requestPasswordReset} aria-label="Reset your password" className="flex flex-col gap-4">
      <FormMessage />
      <TextField
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <SubmitButton pendingLabel="Sending…">Send reset link</SubmitButton>
    </ActionForm>
  )
}

export function ResetPasswordForm() {
  return (
    <ActionForm action={resetPassword} aria-label="Choose a new password" className="flex flex-col gap-4">
      <FormMessage />
      <FieldGroup>
        <TextField
          name="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_LIMITS.minLength}
          description={PASSWORD_HINT}
        />
        <TextField name="confirmPassword" label="Repeat the new password" type="password" autoComplete="new-password" required />
      </FieldGroup>
      <SubmitButton pendingLabel="Saving…">Save new password</SubmitButton>
    </ActionForm>
  )
}

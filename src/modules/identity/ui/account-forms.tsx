'use client'

import { LogOut } from 'lucide-react'
import { useState } from 'react'

import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { TextField } from '@/components/forms/text-field'
import { FieldGroup } from '@/components/ui/field'

import { PASSWORD_LIMITS } from '../domain/auth'
import { changePassword, signOutEverywhere, updateProfile } from '../server/auth-actions'

export function ProfileForm({ fullName, email }: { fullName: string; email: string | null }) {
  const [name, setName] = useState(fullName)
  return (
    <ActionForm action={updateProfile} aria-label="Profile" className="flex max-w-lg flex-col gap-4">
      <FormMessage />
      <FieldGroup>
        <TextField
          name="fullName"
          label="Your name"
          autoComplete="name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          name="emailDisplay"
          label="Email"
          value={email ?? ''}
          readOnly
          disabled
          description="The address you sign in with. Changing it isn’t available yet."
        />
      </FieldGroup>
      <div>
        <SubmitButton>Save profile</SubmitButton>
      </div>
    </ActionForm>
  )
}

export function ChangePasswordForm() {
  // Uncontrolled on purpose: React clears the password fields after each submission.
  return (
    <ActionForm action={changePassword} aria-label="Change password" className="flex max-w-lg flex-col gap-4">
      <FormMessage successFallback="Password changed." />
      <FieldGroup>
        <TextField name="currentPassword" label="Current password" type="password" autoComplete="current-password" required />
        <TextField
          name="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_LIMITS.minLength}
          description={`At least ${PASSWORD_LIMITS.minLength} characters. Your other devices will be signed out.`}
        />
        <TextField name="confirmPassword" label="Repeat the new password" type="password" autoComplete="new-password" required />
      </FieldGroup>
      <div>
        <SubmitButton>Change password</SubmitButton>
      </div>
    </ActionForm>
  )
}

export function SignOutEverywhereForm() {
  return (
    <ActionForm action={signOutEverywhere} aria-label="Sign out on all devices" className="flex flex-col gap-3">
      <FormMessage />
      <div>
        <SubmitButton variant="outline" pendingLabel="Signing out…">
          <LogOut data-icon="inline-start" aria-hidden="true" />
          Sign out on all devices
        </SubmitButton>
      </div>
    </ActionForm>
  )
}

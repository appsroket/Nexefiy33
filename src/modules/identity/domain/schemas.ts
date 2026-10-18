// Validation schemas for every identity form. They mirror the database check
// constraints so forms can explain problems before saving; the database still
// enforces them. Server-side only in practice: client components import the
// Zod-free constants from auth.ts, workspace.ts and invitations.ts instead, so
// Zod stays out of the browser bundle.

import { z } from 'zod'

import { PASSWORD_LIMITS } from './auth'
import { INVITABLE_ROLES } from './invitations'
import { SLUG_PATTERN, WORKSPACE_NAME_MAX_LENGTH } from './workspace'

// Accounts ---------------------------------------------------------------------

const emailField = z
  .string({ error: 'Enter your email address.' })
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .pipe(z.email('Enter a valid email address.'))

const newPasswordField = z
  .string({ error: 'Choose a password.' })
  .min(PASSWORD_LIMITS.minLength, `Use at least ${PASSWORD_LIMITS.minLength} characters.`)
  .refine((value) => new TextEncoder().encode(value).length <= PASSWORD_LIMITS.maxBytes, {
    message: `Use at most ${PASSWORD_LIMITS.maxBytes} characters.`,
  })

export const signInSchema = z.object({
  email: emailField,
  // Existing passwords are checked by Supabase, not re-validated here.
  password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.').max(1000),
})

const fullNameField = z
  .string({ error: 'Enter your name.' })
  .trim()
  .min(1, 'Enter your name.')
  .max(200, 'Use at most 200 characters.')

export const signUpSchema = z.object({
  fullName: fullNameField,
  email: emailField,
  password: newPasswordField,
})

export const profileSchema = z.object({ fullName: fullNameField })

export const emailOnlySchema = z.object({ email: emailField })

export const newPasswordSchema = z
  .object({ password: newPasswordField, confirmPassword: z.string({ error: 'Repeat the password.' }) })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The passwords don’t match.',
  })

export const changePasswordSchema = z
  .object({
    currentPassword: z.string({ error: 'Enter your current password.' }).min(1, 'Enter your current password.').max(1000),
    password: newPasswordField,
    confirmPassword: z.string({ error: 'Repeat the new password.' }),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The passwords don’t match.',
  })

// Workspaces -------------------------------------------------------------------

export const workspaceSchema = z.object({
  name: z
    .string({ error: 'Enter a workspace name.' })
    .trim()
    .min(1, 'Enter a workspace name.')
    .max(WORKSPACE_NAME_MAX_LENGTH, `Use at most ${WORKSPACE_NAME_MAX_LENGTH} characters.`),
  slug: z
    .string({ error: 'Enter a workspace address.' })
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, 'Use 3 to 48 lowercase letters, numbers and dashes, starting and ending with a letter or number.'),
})

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .optional()
    .transform((value) => value || null)

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const companyDetailsSchema = z.object({
  legalName: optionalText(200),
  industry: optionalText(100),
  website: z
    .string()
    .trim()
    .max(500, 'Use at most 500 characters.')
    .optional()
    .transform((value) => (value ? (/^https?:\/\//i.test(value) ? value : `https://${value}`) : null))
    .refine((value) => value === null || URL.canParse(value), 'Enter a website address, like example.com.'),
  description: optionalText(5000),
  timezone: z
    .string({ error: 'Choose a time zone.' })
    .trim()
    .min(1, 'Choose a time zone.')
    .max(64)
    .refine(isTimeZone, 'Choose a valid time zone.'),
})

export type CompanyDetails = z.infer<typeof companyDetailsSchema>

// Invitations ------------------------------------------------------------------

export const inviteSchema = z.object({
  email: z
    .string({ error: 'Enter an email address.' })
    .trim()
    .toLowerCase()
    .min(1, 'Enter an email address.')
    .max(254, 'That email address is too long.')
    .pipe(z.email('Enter a valid email address.')),
  role: z.enum(INVITABLE_ROLES, { error: 'Choose a role.' }),
})

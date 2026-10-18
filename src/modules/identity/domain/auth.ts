// Auth paths, password limits, safe redirects and plain-language auth errors,
// shared by the forms and the Server Actions. Pure, and free of Zod so client
// components can import it; validation schemas are in schemas.ts.

export const AUTH_PATHS = {
  signIn: '/sign-in',
  signUp: '/sign-up',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  callback: '/auth/callback',
  confirm: '/auth/confirm',
  invite: '/invite',
} as const

export const DEFAULT_AFTER_SIGN_IN = '/app'

/** Supabase stores bcrypt hashes, which only use the first 72 bytes of a password. */
export const PASSWORD_LIMITS = { minLength: 8, maxBytes: 72 } as const

/**
 * Where to go after signing in or following an email link. Only known
 * in-app paths are allowed, so a crafted `next` can never send someone to
 * another site (open redirect) or to an unexpected page.
 */
export function safeNextPath(value: unknown, fallback: string = DEFAULT_AFTER_SIGN_IN): string {
  if (typeof value !== 'string') return fallback
  if (/^\/app(\/[a-z0-9-]+)*$/.test(value)) return value
  if (value === AUTH_PATHS.invite || value === AUTH_PATHS.resetPassword) return value
  return fallback
}

/** The email-link landing URL that exchanges the one-time code for a session. */
export function authCallbackUrl(appUrl: string, next: string): string {
  const url = new URL(AUTH_PATHS.callback, appUrl)
  url.searchParams.set('next', safeNextPath(next))
  return url.toString()
}

/** Codes from Supabase Auth (AuthError.code) that need their own wording. */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'The email address or password is incorrect.',
  email_not_confirmed: 'Confirm your email address first. Check your inbox for the confirmation link.',
  user_already_exists: 'An account with this email address already exists. Sign in instead.',
  email_exists: 'An account with this email address already exists. Sign in instead.',
  weak_password: 'Choose a stronger password: longer, and not a common one.',
  same_password: 'Choose a password that is different from your current one.',
  signup_disabled: 'New accounts can’t be created right now.',
  email_address_invalid: 'That email address can’t be used. Try another one.',
  over_email_send_rate_limit: 'Too many emails were sent recently. Please wait a few minutes and try again.',
  over_request_rate_limit: 'Too many attempts. Please wait a few minutes and try again.',
  reauthentication_needed: 'For your security, sign out and sign in again before changing your password.',
  session_not_found: 'Your session has ended. Please sign in again.',
  user_banned: 'This account has been suspended.',
}

export const GENERIC_AUTH_ERROR = 'Something went wrong. Please try again.'

export function authErrorMessage(code: string | undefined): string {
  return code && Object.hasOwn(AUTH_ERROR_MESSAGES, code) ? AUTH_ERROR_MESSAGES[code]! : GENERIC_AUTH_ERROR
}

/** Reasons shown on the sign-in page after a redirect (?error=…). */
export const SIGN_IN_NOTICES = {
  link: 'That link is invalid or has expired. Sign in, or ask for a new link.',
  session: 'Your session has ended. Please sign in again.',
} as const

export type SignInNotice = keyof typeof SIGN_IN_NOTICES

export function signInNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(SIGN_IN_NOTICES, value) ? SIGN_IN_NOTICES[value as SignInNotice] : null
}

/** The first value of a search parameter (Next.js gives arrays for repeated keys). */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

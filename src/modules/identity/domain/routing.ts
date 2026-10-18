// Where the proxy sends a request, given whether there is a valid session.
// Pure, so every rule is unit-tested. Returns null to let the request through.

import { AUTH_PATHS, DEFAULT_AFTER_SIGN_IN, safeNextPath } from './auth'

/** Pages for signed-out people; signed-in people are sent into the app instead. */
const SIGNED_OUT_ONLY = new Set<string>([AUTH_PATHS.signIn, AUTH_PATHS.signUp, AUTH_PATHS.forgotPassword])

export function isAppPath(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/')
}

export function routeForSession(url: URL, signedIn: boolean): URL | null {
  const { pathname, searchParams } = url

  // An email link that fell back to the Site URL: finish it in the callback.
  if (pathname === '/' && searchParams.has('code')) {
    const callback = new URL(AUTH_PATHS.callback, url)
    callback.searchParams.set('code', searchParams.get('code') ?? '')
    callback.searchParams.set('next', DEFAULT_AFTER_SIGN_IN)
    return callback
  }

  if (isAppPath(pathname) && !signedIn) {
    const signIn = new URL(AUTH_PATHS.signIn, url)
    const next = safeNextPath(pathname, '')
    if (next && next !== DEFAULT_AFTER_SIGN_IN) signIn.searchParams.set('next', next)
    return signIn
  }

  if (SIGNED_OUT_ONLY.has(pathname) && signedIn) {
    return new URL(safeNextPath(searchParams.get('next')), url)
  }

  // Reached only through a password-reset email link, which signs the person in.
  if (pathname === AUTH_PATHS.resetPassword && !signedIn) {
    const forgot = new URL(AUTH_PATHS.forgotPassword, url)
    forgot.searchParams.set('expired', '1')
    return forgot
  }

  return null
}

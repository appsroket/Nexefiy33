import type { NextRequest } from 'next/server'

import { redirectWithSession, refreshSession } from '@/lib/supabase/session'
import { routeForSession } from '@/modules/identity/domain/routing'

export async function proxy(request: NextRequest) {
  const session = await refreshSession(request)
  const target = routeForSession(new URL(request.url), session.userId !== null)
  return target ? redirectWithSession(session, target) : session.response
}

export const config = {
  // Only routes that depend on the session run the proxy, so the public
  // website stays static. The proxy is a convenience (fast redirects); every
  // page and Server Action still checks the session itself.
  matcher: [
    '/app',
    '/app/:path*',
    '/sign-in',
    '/sign-up',
    '/forgot-password',
    '/reset-password',
    // Supabase falls back to the Site URL when a redirect URL isn't allowed.
    { source: '/', has: [{ type: 'query', key: 'code' }] },
  ],
}

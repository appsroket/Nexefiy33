// Session refresh for the proxy (src/proxy.ts). Runs before the matched page
// requests so expired access tokens are refreshed and written back as cookies
// before Server Components read them.

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { getPublicEnv } from '@/lib/env/public'

import type { Database } from './database.types'

export interface RefreshedSession {
  response: NextResponse
  /** The signed-in user's id, or null when there is no valid session. */
  userId: string | null
}

export async function refreshSession(request: NextRequest): Promise<RefreshedSession> {
  let response = NextResponse.next({ request })
  const { supabaseUrl, supabasePublishableKey } = getPublicEnv()

  const supabase = createServerClient<Database>(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options)
        // Responses that set auth cookies must never be cached by a CDN.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)
      },
    },
  })

  // Verifies the access token (refreshing it if needed). Do not put code
  // between client creation and this call.
  const { data, error } = await supabase.auth.getClaims()
  const userId = !error && typeof data?.claims.sub === 'string' ? data.claims.sub : null
  return { response, userId }
}

/** A redirect that keeps any auth cookies the refresh just wrote. */
export function redirectWithSession(session: RefreshedSession, url: URL): NextResponse {
  const redirect = NextResponse.redirect(url)
  for (const cookie of session.response.cookies.getAll()) redirect.cookies.set(cookie)
  const cacheControl = session.response.headers.get('cache-control')
  if (cacheControl) redirect.headers.set('cache-control', cacheControl)
  return redirect
}

// User-scoped Supabase client for Server Components, Server Actions and Route
// Handlers. It carries the signed-in user's session from cookies, so every
// query runs under RLS as that user. Create one per request; never share it.

import 'server-only'

import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

import { getServerEnv } from '@/lib/env/server'

import type { Database } from './database.types'

export type UserClient = SupabaseClient<Database>

export async function createUserClient(): Promise<UserClient> {
  const cookieStore = await cookies()
  const { supabaseUrl, supabasePublishableKey } = getServerEnv().core
  return createServerClient<Database>(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options)
        } catch {
          // Server Components cannot write cookies. The proxy (src/proxy.ts)
          // refreshes the session on every request, so this is safe to skip.
        }
      },
    },
  })
}

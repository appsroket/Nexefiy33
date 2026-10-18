// Supabase client for Client Components. Uses only the public URL and
// publishable key; every query runs under RLS as the signed-in user.

'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import { getPublicEnv } from '@/lib/env/public'

import type { Database } from './database.types'

let client: SupabaseClient<Database> | undefined

export function getBrowserClient(): SupabaseClient<Database> {
  if (!client) {
    const { supabaseUrl, supabasePublishableKey } = getPublicEnv()
    client = createBrowserClient<Database>(supabaseUrl, supabasePublishableKey)
  }
  return client
}

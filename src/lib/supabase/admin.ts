// Privileged Supabase client (secret key). Bypasses RLS, so it is only for
// trusted server code with no user session: workers, inbound webhooks,
// billing sync, OAuth callbacks writing encrypted credentials.
//
// Every query made with it must filter by organization_id explicitly
// (CLAUDE.md rule 4). Prefer the user-scoped client wherever a session exists.

import 'server-only'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { getServerEnv, requireFeature } from '@/lib/env/server'

import type { Database } from './database.types'

export type AdminClient = SupabaseClient<Database>

let client: AdminClient | undefined

/** Throws FeatureUnavailableError (with setup steps) when no secret key is configured. */
export function getAdminClient(): AdminClient {
  if (!client) {
    const { key } = requireFeature('supabaseAdmin')
    client = createClient<Database>(getServerEnv().core.supabaseUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }
  return client
}

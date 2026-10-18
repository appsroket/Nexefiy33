// Connecting an account: the OAuth authorization code flow.
//
// 1. startAuthorization: an admin clicks Connect. A random state is created;
//    only its SHA-256 is stored, bound to the organization, the user and a
//    10-minute expiry. The browser is sent to the provider.
// 2. completeAuthorization: the provider redirects back with code and state.
//    The state is consumed exactly once (and must belong to the same user and
//    provider), the code is exchanged server-side, the tokens are encrypted
//    and stored, and the connection and its actions are recorded.
//
// The caller (route handler) has already verified the user's session and
// role; this module re-checks nothing about the browser and trusts nothing it
// sends except the opaque code and state.

import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { absoluteUrl } from '@/lib/config/endpoints'
import { redact } from '@/lib/logging/redact'
import type { Json } from '@/lib/supabase/types'

import { requestedScopes } from '../connectors/registry'
import type { ConnectorDefinition } from '../connectors/types'
import { IntegrationError } from '../domain/errors'
import { defaultApprovalMode } from '../domain/policy'
import { storeTokens } from './credentials'
import { createHttpClient } from './http'
import { callbackPath, type IntegrationRuntime } from './runtime'

const STATE_TTL_MS = 10 * 60_000

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex')
}

export class AuthorizationError extends Error {
  override name = 'AuthorizationError'
  constructor(
    readonly reason: 'invalid_state' | 'different_account' | 'provider_denied' | 'exchange_failed' | 'save_failed',
    message: string,
  ) {
    super(message)
  }
}

export async function startAuthorization(
  runtime: IntegrationRuntime,
  connector: ConnectorDefinition,
  params: { organizationId: string; userId: string; integrationId?: string; returnPath?: string },
): Promise<string> {
  const client = runtime.oauthClient(connector)
  const state = randomBytes(32).toString('base64url')
  const now = runtime.now()
  const { error } = await runtime.admin.from('integration_oauth_states').insert({
    organization_id: params.organizationId,
    provider: connector.provider,
    user_id: params.userId,
    state_sha256: hashState(state),
    integration_id: params.integrationId ?? null,
    return_path: params.returnPath ?? '/app/integrations',
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  })
  if (error) {
    console.error('[integrations] creating OAuth state failed', redact({ code: error.code }))
    throw new IntegrationError('unavailable', { message: 'Couldn’t start connecting. Please try again.', mayHaveReachedProvider: false })
  }

  const url = new URL(connector.auth.authorizeUrl)
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', absoluteUrl(runtime.appUrl, callbackPath(connector.provider)))
  url.searchParams.set('scope', requestedScopes(connector).join(connector.auth.scopeSeparator))
  url.searchParams.set('state', state)
  for (const [key, value] of Object.entries(connector.auth.authorizeParams ?? {})) url.searchParams.set(key, value)
  return url.toString()
}

export interface CompletedAuthorization {
  integrationId: string
  organizationId: string
  returnPath: string
  reconnected: boolean
}

async function consumeState(runtime: IntegrationRuntime, connector: ConnectorDefinition, state: string, userId: string) {
  const { data, error } = await runtime.admin
    .from('integration_oauth_states')
    .update({ consumed_at: runtime.now().toISOString() })
    .eq('state_sha256', hashState(state))
    .eq('provider', connector.provider)
    .eq('user_id', userId)
    .is('consumed_at', null)
    .gt('expires_at', runtime.now().toISOString())
    .select('organization_id, integration_id, return_path')
  if (error) {
    console.error('[integrations] consuming OAuth state failed', redact({ code: error.code }))
    throw new AuthorizationError('save_failed', 'Couldn’t finish connecting. Please try again.')
  }
  const row = data?.[0]
  if (!row) throw new AuthorizationError('invalid_state', 'This connection link has expired or was already used. Start again from Integrations.')
  return row
}

/** The state's organization, without consuming it (lets the route check the user's role there first). */
export async function peekState(runtime: IntegrationRuntime, connector: ConnectorDefinition, state: string, userId: string) {
  const { data } = await runtime.admin
    .from('integration_oauth_states')
    .select('organization_id')
    .eq('state_sha256', hashState(state))
    .eq('provider', connector.provider)
    .eq('user_id', userId)
    .is('consumed_at', null)
    .gt('expires_at', runtime.now().toISOString())
    .maybeSingle()
  return data?.organization_id ?? null
}

export async function completeAuthorization(
  runtime: IntegrationRuntime,
  connector: ConnectorDefinition,
  params: { state: string; code: string; userId: string },
): Promise<CompletedAuthorization> {
  const stateRow = await consumeState(runtime, connector, params.state, params.userId)
  const organizationId = stateRow.organization_id

  const http = createHttpClient({ fetch: runtime.fetch, timeoutMs: connector.requestTimeoutMs, defaultBuckets: [] })
  let exchanged
  try {
    exchanged = await connector.auth.exchangeCode(http, runtime.oauthClient(connector), {
      code: params.code,
      redirectUri: absoluteUrl(runtime.appUrl, callbackPath(connector.provider)),
    })
  } catch (error) {
    console.error('[integrations] code exchange failed', redact({ provider: connector.provider, error }))
    throw new AuthorizationError('exchange_failed', `${connector.displayName} didn’t complete the connection. Please try again.`)
  }
  const { tokens, account } = exchanged
  const grantedScopes = account.scopes?.length ? account.scopes : tokens.scopes

  // Reconnecting must authorize the same account the connection belongs to.
  let existing: { id: string; external_account_id: string | null } | null = null
  if (stateRow.integration_id) {
    const { data } = await runtime.admin
      .from('integrations')
      .select('id, external_account_id')
      .eq('id', stateRow.integration_id)
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (data && data.external_account_id !== account.externalAccountId) {
      throw new AuthorizationError('different_account', `You authorized a different ${connector.displayName} account than the one this connection uses.`)
    }
    existing = data
  }
  if (!existing) {
    const { data } = await runtime.admin
      .from('integrations')
      .select('id, external_account_id')
      .eq('organization_id', organizationId)
      .eq('provider', connector.provider)
      .eq('external_account_id', account.externalAccountId)
      .maybeSingle()
    existing = data
  }

  const now = runtime.now().toISOString()
  const metadata = account.metadata as Json
  let integrationId: string
  if (existing) {
    integrationId = existing.id
  } else {
    const { data, error } = await runtime.admin
      .from('integrations')
      .insert({
        organization_id: organizationId,
        provider: connector.provider,
        display_name: account.label.slice(0, 120) || connector.displayName,
        status: 'pending',
        external_account_id: account.externalAccountId,
        external_account_label: account.label.slice(0, 255),
        granted_scopes: grantedScopes,
        provider_metadata: metadata,
        connected_by: params.userId,
      })
      .select('id')
      .single()
    if (error || !data) {
      console.error('[integrations] recording the connection failed', redact({ code: error?.code }))
      throw new AuthorizationError('save_failed', 'Couldn’t save the connection. Please try again.')
    }
    integrationId = data.id
  }

  const connection = { id: integrationId, organizationId }
  try {
    await storeTokens(runtime, connection, tokens)
  } catch {
    if (!existing) await runtime.admin.from('integrations').delete().eq('id', integrationId).eq('organization_id', organizationId)
    throw new AuthorizationError('save_failed', 'Couldn’t save the connection’s credentials. Please try again.')
  }

  const { error: updateError } = await runtime.admin
    .from('integrations')
    .update({
      status: 'connected',
      connected_at: now,
      connected_by: params.userId,
      revoked_at: null,
      last_error: null,
      external_account_label: account.label.slice(0, 255),
      granted_scopes: grantedScopes,
      provider_metadata: metadata,
      health_status: 'healthy',
      health_message: 'Connected.',
      last_health_check_at: now,
    })
    .eq('id', integrationId)
    .eq('organization_id', organizationId)
  if (updateError) {
    console.error('[integrations] activating the connection failed', redact({ code: updateError.code }))
    throw new AuthorizationError('save_failed', 'Couldn’t save the connection. Please try again.')
  }

  // One settings row per action, created with the declared defaults; existing settings are kept.
  const { error: actionsError } = await runtime.admin.from('integration_actions').upsert(
    connector.actions.map((action) => ({
      organization_id: organizationId,
      integration_id: integrationId,
      action_key: action.key,
      risk_level: action.risk,
      approval_mode: defaultApprovalMode(action.approval),
    })),
    { onConflict: 'integration_id,action_key', ignoreDuplicates: true },
  )
  if (actionsError) console.error('[integrations] seeding action settings failed', redact({ code: actionsError.code }))

  await runtime.admin.from('audit_logs').insert({
    organization_id: organizationId,
    actor_type: 'user',
    actor_user_id: params.userId,
    action: existing ? 'integration.reconnected' : 'integration.connected',
    target_table: 'integrations',
    target_id: integrationId,
    metadata: { provider: connector.provider, scopes: grantedScopes },
  })

  return { integrationId, organizationId, returnPath: stateRow.return_path, reconnected: Boolean(existing) }
}

/** Deletes expired or used OAuth states (housekeeping; called by the cron route). */
export async function purgeOAuthStates(runtime: IntegrationRuntime): Promise<void> {
  const cutoff = new Date(runtime.now().getTime() - 24 * 60 * 60_000).toISOString()
  const { error } = await runtime.admin.from('integration_oauth_states').delete().lt('expires_at', cutoff)
  if (error) console.error('[integrations] purging OAuth states failed', redact({ code: error.code }))
}

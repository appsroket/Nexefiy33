// Encrypted storage of OAuth tokens and safe access-token renewal.
//
// Tokens are encrypted with encryptCredential() (AES-256-GCM, bound to the
// organization and connection, ADR-014) and stored in integration_secrets,
// which only the service role can read. Decrypted tokens exist only in memory
// for the duration of a provider call; they are never logged or returned.
//
// Renewal is serialized with a short lease on the secret row, because a
// provider that rotates refresh tokens (Slack with rotation enabled)
// invalidates the old one: two servers refreshing at once would lose access.

import 'server-only'

import { credentialKeyId, decryptCredential, encryptCredential } from '@/lib/crypto/credential-encryption'
import { redact } from '@/lib/logging/redact'

import type { ConnectorDefinition, TokenSet } from '../connectors/types'
import { IntegrationError, isIntegrationError } from '../domain/errors'
import { createHttpClient } from './http'
import type { IntegrationRuntime } from './runtime'

const PURPOSE = 'oauth_tokens'
/** Renew when less than this much lifetime is left. */
const REFRESH_MARGIN_MS = 2 * 60_000
const LEASE_MS = 30_000
const WAIT_STEP_MS = 500
const WAIT_STEPS = 8

export interface ConnectionRef {
  id: string
  organizationId: string
}

interface StoredTokens extends TokenSet {
  v: 1
}

function context(connection: ConnectionRef) {
  return { organizationId: connection.organizationId, connectionId: connection.id, purpose: PURPOSE }
}

export async function storeTokens(runtime: IntegrationRuntime, connection: ConnectionRef, tokens: TokenSet): Promise<void> {
  const payload: StoredTokens = { v: 1, ...tokens }
  const ciphertext = encryptCredential(runtime.keyring, JSON.stringify(payload), context(connection))
  const { error } = await runtime.admin.from('integration_secrets').upsert(
    {
      integration_id: connection.id,
      organization_id: connection.organizationId,
      secret_kind: 'oauth_tokens',
      ciphertext,
      key_id: credentialKeyId(ciphertext),
      access_token_expires_at: tokens.expiresAt ?? null,
      rotated_at: runtime.now().toISOString(),
      refresh_lease_until: null,
    },
    { onConflict: 'integration_id,secret_kind' },
  )
  if (error) {
    console.error('[integrations] storing credentials failed', redact({ code: error.code }))
    throw new IntegrationError('unavailable', { message: 'The connection’s credentials couldn’t be saved.', mayHaveReachedProvider: false })
  }
}

function decrypt(runtime: IntegrationRuntime, connection: ConnectionRef, ciphertext: string): TokenSet {
  const parsed = JSON.parse(decryptCredential(runtime.keyring, ciphertext, context(connection))) as Partial<StoredTokens>
  if (parsed.v !== 1 || typeof parsed.accessToken !== 'string') throw new Error('unrecognized credential payload')
  return {
    accessToken: parsed.accessToken,
    ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
    ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
    scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
  }
}

/** The connection's tokens, or null when none are stored. Throws reauth_required when they can't be decrypted. */
export async function loadTokens(runtime: IntegrationRuntime, connection: ConnectionRef): Promise<TokenSet | null> {
  const { data, error } = await runtime.admin
    .from('integration_secrets')
    .select('ciphertext')
    .eq('integration_id', connection.id)
    .eq('organization_id', connection.organizationId)
    .eq('secret_kind', 'oauth_tokens')
    .maybeSingle()
  if (error) {
    console.error('[integrations] loading credentials failed', redact({ code: error.code }))
    throw new IntegrationError('unavailable', { message: 'The connection’s credentials couldn’t be loaded.', mayHaveReachedProvider: false })
  }
  if (!data) return null
  try {
    return decrypt(runtime, connection, data.ciphertext)
  } catch (error) {
    console.error('[integrations] credentials could not be decrypted', redact({ name: (error as Error).name }))
    throw new IntegrationError('reauth_required', { message: 'The stored credentials can’t be read. Reconnect the integration.' })
  }
}

export async function deleteTokens(runtime: IntegrationRuntime, connection: ConnectionRef): Promise<void> {
  const { error } = await runtime.admin
    .from('integration_secrets')
    .delete()
    .eq('integration_id', connection.id)
    .eq('organization_id', connection.organizationId)
  if (error) {
    console.error('[integrations] deleting credentials failed', redact({ code: error.code }))
    throw new IntegrationError('unavailable', { message: 'The connection’s credentials couldn’t be deleted.', mayHaveReachedProvider: false })
  }
}

function needsRefresh(tokens: TokenSet, now: Date): boolean {
  return tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) - now.getTime() < REFRESH_MARGIN_MS
}

function isExpired(tokens: TokenSet, now: Date): boolean {
  return tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) <= now.getTime()
}

/** Marks a connected integration as needing to be reconnected. */
export async function markNeedsReauth(runtime: IntegrationRuntime, connection: ConnectionRef, message: string): Promise<void> {
  const { error } = await runtime.admin
    .from('integrations')
    .update({ status: 'needs_reauth', health_status: 'unhealthy', health_message: message.slice(0, 500), last_error: message.slice(0, 2000) })
    .eq('id', connection.id)
    .eq('organization_id', connection.organizationId)
    .in('status', ['connected', 'error'])
  if (error) console.error('[integrations] marking connection for reconnection failed', redact({ code: error.code }))
}

/**
 * A usable access token, renewed first when it is about to expire (or when
 * `force` is set after the provider rejected it). Throws reauth_required when
 * the connection must be reconnected.
 */
export async function getAccessToken(
  runtime: IntegrationRuntime,
  connector: ConnectorDefinition,
  connection: ConnectionRef,
  options: { force?: boolean } = {},
): Promise<string> {
  let tokens = await loadTokens(runtime, connection)
  if (!tokens) throw new IntegrationError('reauth_required', { message: 'This connection has no stored credentials. Reconnect it.' })
  if (!options.force && !needsRefresh(tokens, runtime.now())) return tokens.accessToken
  if (!tokens.refreshToken) {
    if (isExpired(tokens, runtime.now()) || options.force) {
      throw new IntegrationError('reauth_required', { message: 'The access token expired and can’t be renewed. Reconnect the integration.' })
    }
    return tokens.accessToken
  }

  const nowIso = runtime.now().toISOString()
  const { data: leased, error } = await runtime.admin
    .from('integration_secrets')
    .update({ refresh_lease_until: new Date(runtime.now().getTime() + LEASE_MS).toISOString() })
    .eq('integration_id', connection.id)
    .eq('organization_id', connection.organizationId)
    .eq('secret_kind', 'oauth_tokens')
    .or(`refresh_lease_until.is.null,refresh_lease_until.lt.${nowIso}`)
    .select('ciphertext')
  if (error) {
    console.error('[integrations] taking the refresh lease failed', redact({ code: error.code }))
    throw new IntegrationError('unavailable', { message: 'The access token couldn’t be renewed.', mayHaveReachedProvider: false })
  }

  if (!leased?.length) {
    // Another server is renewing the token: wait for its result.
    const before = tokens.accessToken
    for (let step = 0; step < WAIT_STEPS; step += 1) {
      await runtime.sleep(WAIT_STEP_MS)
      tokens = await loadTokens(runtime, connection)
      if (!tokens) throw new IntegrationError('reauth_required', { message: 'This connection has no stored credentials. Reconnect it.' })
      if (tokens.accessToken !== before && !needsRefresh(tokens, runtime.now())) return tokens.accessToken
    }
    throw new IntegrationError('unavailable', { message: 'The access token is being renewed. Try again shortly.', mayHaveReachedProvider: false })
  }

  // A concurrent renewal may have finished between our read and the lease.
  const current = decrypt(runtime, connection, leased[0]!.ciphertext)
  if (current.accessToken !== tokens.accessToken && !needsRefresh(current, runtime.now()) && !options.force) {
    await releaseLease(runtime, connection)
    return current.accessToken
  }

  const http = createHttpClient({ fetch: runtime.fetch, timeoutMs: connector.requestTimeoutMs, defaultBuckets: [] })
  try {
    const renewed = await connector.auth.refresh(http, runtime.oauthClient(connector), current.refreshToken ?? tokens.refreshToken)
    await storeTokens(runtime, connection, { ...renewed, refreshToken: renewed.refreshToken ?? current.refreshToken })
    return renewed.accessToken
  } catch (error) {
    await releaseLease(runtime, connection)
    if (isIntegrationError(error) && error.code === 'reauth_required') {
      await markNeedsReauth(runtime, connection, `${connector.displayName} refused to renew the access token. Reconnect the integration.`)
    }
    throw error
  }
}

async function releaseLease(runtime: IntegrationRuntime, connection: ConnectionRef): Promise<void> {
  const { error } = await runtime.admin
    .from('integration_secrets')
    .update({ refresh_lease_until: null })
    .eq('integration_id', connection.id)
    .eq('organization_id', connection.organizationId)
    .eq('secret_kind', 'oauth_tokens')
  if (error) console.error('[integrations] releasing the refresh lease failed', redact({ code: error.code }))
}

// Everything integration server code needs from the environment, gathered in
// one object so tests can supply fakes (database, fetch, keys, clock).

import 'server-only'

import type { Keyring } from '@/lib/crypto/keyring'
import { getServerEnv, isFeatureConfigured, requireFeature } from '@/lib/env/server'
import { getAdminClient, type AdminClient } from '@/lib/supabase/admin'

import type { ConnectorDefinition, OAuthClient } from '../connectors/types'
import { IntegrationError } from '../domain/errors'
import { sleep, type FetchLike } from './http'

export interface IntegrationRuntime {
  admin: AdminClient
  fetch: FetchLike
  keyring: Keyring
  appUrl: string
  oauthClient(connector: ConnectorDefinition): OAuthClient
  now(): Date
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** True when this deployment can connect the provider: client credentials, encryption keys and the Supabase secret key. */
export function isConnectorConfigured(connector: ConnectorDefinition): boolean {
  return isFeatureConfigured(connector.feature) && isFeatureConfigured('credentialEncryption') && isFeatureConfigured('supabaseAdmin')
}

/** Running actions needs the Supabase secret key and the credential encryption keys. */
export function canRunIntegrations(): boolean {
  return isFeatureConfigured('supabaseAdmin') && isFeatureConfigured('credentialEncryption')
}

export function getIntegrationRuntime(): IntegrationRuntime {
  const { keyring } = requireFeature('credentialEncryption')
  return {
    admin: getAdminClient(),
    fetch: (input, init) => fetch(input, init),
    keyring,
    appUrl: getServerEnv().core.appUrl,
    oauthClient(connector) {
      if (!isFeatureConfigured(connector.feature)) throw new IntegrationError('not_configured')
      const { clientId, clientSecret } = requireFeature(connector.feature)
      return { clientId, clientSecret }
    },
    now: () => new Date(),
    sleep,
  }
}

export function callbackPath(provider: string): string {
  return `/api/integrations/${provider}/callback`
}

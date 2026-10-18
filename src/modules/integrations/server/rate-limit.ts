// Gate for provider calls: counts each request in the shared Postgres windows
// (consume_integration_rate_limit) and refuses it locally, before it reaches
// the provider, when a window is full.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import type { AdminClient } from '@/lib/supabase/admin'

import { rateLimitRuleFor } from '../connectors/registry'
import type { ConnectorDefinition } from '../connectors/types'
import { IntegrationError } from '../domain/errors'
import type { RateLimitGate } from './http'

export function createRateLimitGate(
  admin: AdminClient,
  connector: ConnectorDefinition,
  connection: { id: string; organizationId: string },
): RateLimitGate {
  return async (buckets) => {
    for (const bucket of buckets) {
      const rule = rateLimitRuleFor(connector, bucket)
      if (!rule) continue
      const { data, error } = await admin.rpc('consume_integration_rate_limit', {
        p_organization_id: connection.organizationId,
        p_integration_id: connection.id,
        p_bucket: bucket,
        p_limit: rule.limit,
        p_window_seconds: rule.windowSeconds,
      })
      if (error) {
        // Counting failed: don't send blind. The request certainly didn't leave.
        console.error('[integrations] rate limit check failed', redact({ code: error.code, bucket }))
        throw new IntegrationError('unavailable', { message: 'Couldn’t check the provider rate limit.', mayHaveReachedProvider: false })
      }
      const row = Array.isArray(data) ? data[0] : data
      if (!row?.allowed) {
        throw new IntegrationError('rate_limited', {
          message: `Nexefiy paused requests to stay within ${connector.displayName}’s rate limit.`,
          providerCode: 'local_limit',
          retryAfterMs: row?.retry_after_ms ?? rule.windowSeconds * 1000,
          mayHaveReachedProvider: false,
        })
      }
    }
  }
}

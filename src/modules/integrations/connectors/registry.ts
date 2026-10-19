// The connectors Nexefiy ships, and lookups by provider and action key.
// Adding a connector means adding its definition here; the framework, pages
// and test console pick it up from the registry.

import { z } from 'zod'

import { defaultApprovalMode } from '../domain/policy'
import type { ActionSummary, ConnectorSummary, ProviderKey } from '../domain/types'
import { hubspotConnector } from './hubspot'
import { slackConnector } from './slack'
import type { ActionDefinition, ConnectorDefinition } from './types'

export const CONNECTORS: readonly ConnectorDefinition[] = [hubspotConnector, slackConnector]

const BY_PROVIDER = new Map<string, ConnectorDefinition>(CONNECTORS.map((connector) => [connector.provider, connector]))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BY_ACTION = new Map<string, { connector: ConnectorDefinition; action: ActionDefinition<any, any> }>(
  CONNECTORS.flatMap((connector) => connector.actions.map((action) => [action.key, { connector, action }] as const)),
)

export function getConnector(provider: string): ConnectorDefinition | undefined {
  return BY_PROVIDER.get(provider)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findAction(key: string): { connector: ConnectorDefinition; action: ActionDefinition<any, any> } | undefined {
  return BY_ACTION.get(key)
}

/** Every scope a connection asks for: the base scopes plus each action's. */
export function requestedScopes(connector: ConnectorDefinition): string[] {
  return [...new Set([...connector.auth.baseScopes, ...connector.actions.flatMap((action) => action.scopes)])]
}

/** Bucket "slack.post:c123" uses the rule registered for "slack.post". */
export function rateLimitRuleFor(connector: ConnectorDefinition, bucket: string) {
  return connector.rateLimits[bucket] ?? connector.rateLimits[bucket.split(':')[0]!]
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): unknown {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: 'any' })
  } catch {
    return null
  }
}

export function summarizeConnector(connector: ConnectorDefinition, configured: boolean): ConnectorSummary {
  return {
    provider: connector.provider as ProviderKey,
    displayName: connector.displayName,
    category: connector.category,
    description: connector.description,
    docsUrl: connector.docsUrl,
    auth: {
      kind: connector.auth.kind,
      scopes: requestedScopes(connector),
      tokenRefresh: connector.auth.tokenRefresh,
      revocation: connector.auth.revocation,
    },
    configured,
    actions: connector.actions.map(
      (action): ActionSummary => ({
        key: action.key,
        title: action.title,
        description: action.description,
        risk: action.risk,
        category: action.category,
        approval: action.approval,
        defaultApprovalMode: defaultApprovalMode(action.approval),
        scopes: [...action.scopes],
        idempotency: action.idempotency,
        timeoutMs: action.timeoutMs,
        retry: action.retry,
        rateLimit: rateLimitRuleFor(connector, action.rateLimitBucket)!,
        inputSchema: jsonSchema(action.input, 'input'),
        outputSchema: jsonSchema(action.output, 'output'),
        exampleInput: action.exampleInput,
      }),
    ),
  }
}

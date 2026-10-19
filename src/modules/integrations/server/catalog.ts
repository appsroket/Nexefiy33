// The integration actions other modules may build on (AI employees list them
// as tools), and a preview of the decision an action would get, without
// running it. Running an action always goes through requestAction.

import 'server-only'

import { z } from 'zod'

import type { ActionCategory } from '@/modules/governance/domain/risk'

import { CONNECTORS, findAction } from '../connectors/registry'
import type { ApprovalRequirement, RiskLevel } from '../domain/types'

export interface IntegrationToolAction {
  key: string
  provider: string
  providerName: string
  title: string
  description: string
  risk: RiskLevel
  category: ActionCategory
  approval: ApprovalRequirement
  scopes: readonly string[]
  /** Validates the input on the server (the same schema requestAction uses). */
  input: z.ZodType
  /** JSON Schema of the input, for model tool definitions. */
  inputJsonSchema: Record<string, unknown>
}

function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete json.$schema
  return json
}

let cached: IntegrationToolAction[] | null = null

export function listIntegrationToolActions(): IntegrationToolAction[] {
  cached ??= CONNECTORS.flatMap((connector) =>
    connector.actions.map((action) => ({
      key: action.key,
      provider: connector.provider,
      providerName: connector.displayName,
      title: action.title,
      description: action.description,
      risk: action.risk,
      category: action.category,
      approval: action.approval,
      scopes: action.scopes,
      input: action.input,
      inputJsonSchema: inputJsonSchema(action.input),
    })),
  )
  return cached
}

export function getIntegrationToolAction(key: string): IntegrationToolAction | undefined {
  return findAction(key) ? listIntegrationToolActions().find((action) => action.key === key) : undefined
}

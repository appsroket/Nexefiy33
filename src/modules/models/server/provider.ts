// The configured model gateway. Only Anthropic is implemented (ADR-015); when
// AI isn't configured, features that need a model say so instead of failing.

import 'server-only'

import { getServerEnv, isFeatureConfigured } from '@/lib/env/server'

import { createAnthropicGateway } from './anthropic'
import { ModelError, type ModelGateway } from './gateway'

let cached: { key: string; gateway: ModelGateway } | null = null

export function isModelConfigured(): boolean {
  return isFeatureConfigured('ai') && getServerEnv().ai?.provider === 'anthropic'
}

export function getModelGateway(): ModelGateway {
  const ai = isFeatureConfigured('ai') ? getServerEnv().ai : undefined
  if (!ai) throw new ModelError('not_configured', 'No AI model is configured on this deployment (set ANTHROPIC_API_KEY; see docs/credential-setup.md).')
  if (ai.provider !== 'anthropic') throw new ModelError('not_configured', 'Only the Anthropic model provider is implemented. Set AI_PROVIDER=anthropic.')
  if (cached?.key !== ai.apiKey) cached = { key: ai.apiKey, gateway: createAnthropicGateway({ apiKey: ai.apiKey }) }
  return cached.gateway
}

// Model tiers, the concrete models behind them, and their prices. Employees
// choose a tier, never a model id, so models can change without editing
// employees (ADR-015).
//
// Prices are Anthropic first-party API rates in USD per million tokens,
// checked 2026-10-18 against Anthropic's model pages and the Claude API
// reference (cached 2026-10-06). Claude Haiku 5.5 is priced by prompt size:
// prompts over 100K input tokens cost more. Re-check before relying on them
// for billing; they are used to enforce per-task and monthly limits.

import type { ModelEffort, ModelTier } from '@/modules/employees/domain/types'

export interface ModelInfo {
  id: string
  label: string
  /** USD per million tokens. */
  inputPerMillion: number
  outputPerMillion: number
  /** Higher rates above a prompt size, when the model has them. */
  longPrompt?: { aboveInputTokens: number; inputPerMillion: number; outputPerMillion: number }
}

export const MODELS: Record<ModelTier, ModelInfo> = {
  fast: {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    longPrompt: { aboveInputTokens: 100_000, inputPerMillion: 0.5, outputPerMillion: 2.5 },
  },
  balanced: { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', inputPerMillion: 2, outputPerMillion: 10 },
  deep: { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', inputPerMillion: 4, outputPerMillion: 20 },
}

export const TIER_LABELS: Record<ModelTier, { label: string; description: string }> = {
  fast: { label: 'Fast', description: `${MODELS.fast.label}: quickest and cheapest, for simple, well-defined work.` },
  balanced: { label: 'Balanced', description: `${MODELS.balanced.label}: good judgement at moderate cost; the default.` },
  deep: { label: 'Deep', description: `${MODELS.deep.label}: the most capable, for complex reasoning; costs the most.` },
}

export const EFFORT_LABELS: Record<ModelEffort, string> = {
  low: 'Low: fewer, faster steps',
  medium: 'Medium: balanced',
  high: 'High: more thorough, uses more tokens',
}

export function modelForTier(tier: ModelTier): ModelInfo {
  return MODELS[tier]
}

export function findModel(id: string): ModelInfo | undefined {
  return Object.values(MODELS).find((model) => model.id === id)
}

/** Cost of one request in micro-dollars (millionths of a USD), rounded up. */
export function requestCostMicros(model: ModelInfo, inputTokens: number, outputTokens: number): number {
  const rates =
    model.longPrompt && inputTokens > model.longPrompt.aboveInputTokens
      ? model.longPrompt
      : { inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion }
  // USD per million tokens × tokens = micro-dollars.
  return Math.ceil(inputTokens * rates.inputPerMillion + outputTokens * rates.outputPerMillion)
}

/** The most one more turn could cost in output, used to stop before a limit is crossed. */
export function maxOutputCostMicros(model: ModelInfo, maxOutputTokens: number): number {
  const rate = model.longPrompt ? Math.max(model.outputPerMillion, model.longPrompt.outputPerMillion) : model.outputPerMillion
  return Math.ceil(maxOutputTokens * rate)
}

export function microsToUsd(micros: number): number {
  return micros / 1_000_000
}

export function formatUsd(micros: number): string {
  const usd = microsToUsd(micros)
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

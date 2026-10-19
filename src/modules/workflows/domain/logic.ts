// Condition and data-transformation steps: a fixed set of operators and
// formats over resolved values. No expressions are evaluated, so data coming
// from an employee or a provider can never become code. Pure and Zod-free.

import { resolveTemplate, resolveText, type ResolutionScope } from './references'
import type { ConditionConfig, ConditionRule, TransformConfig, TransformFormat } from './types'

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function number(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Equality that treats "5" and 5, "true" and true as equal, and ignores case and surrounding space in text. */
function same(left: unknown, right: unknown): boolean {
  const a = number(left)
  const b = number(right)
  if (a !== null && b !== null) return a === b
  return text(left).trim().toLowerCase() === text(right).trim().toLowerCase()
}

export function evaluateRule(rule: ConditionRule, scope: ResolutionScope): boolean {
  const left = resolveTemplate(rule.left, scope).value
  const right = resolveTemplate(rule.right, scope).value
  switch (rule.operator) {
    case 'equals':
      return same(left, right)
    case 'not_equals':
      return !same(left, right)
    case 'contains':
      return Array.isArray(left) ? left.some((item) => same(item, right)) : text(left).toLowerCase().includes(text(right).toLowerCase())
    case 'not_contains':
      return Array.isArray(left) ? !left.some((item) => same(item, right)) : !text(left).toLowerCase().includes(text(right).toLowerCase())
    case 'greater_than': {
      const a = number(left)
      const b = number(right)
      return a !== null && b !== null && a > b
    }
    case 'less_than': {
      const a = number(left)
      const b = number(right)
      return a !== null && b !== null && a < b
    }
    case 'is_empty':
      return isEmpty(left)
    case 'is_not_empty':
      return !isEmpty(left)
  }
}

export function evaluateCondition(config: ConditionConfig, scope: ResolutionScope): boolean {
  const results = config.rules.map((rule) => evaluateRule(rule, scope))
  return config.match === 'all' ? results.every(Boolean) : results.some(Boolean)
}

export class TransformError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

function format(value: unknown, as: TransformFormat, field: string): unknown {
  switch (as) {
    case 'text':
      return text(value)
    case 'lowercase':
      return text(value).toLowerCase()
    case 'uppercase':
      return text(value).toUpperCase()
    case 'trim':
      return text(value).trim()
    case 'number': {
      const parsed = number(value)
      if (parsed === null) throw new TransformError(field, `“${field}” should be a number, but the value was “${text(value).slice(0, 60)}”.`)
      return parsed
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      const word = text(value).trim().toLowerCase()
      if (['true', 'yes', 'y', '1'].includes(word)) return true
      if (['false', 'no', 'n', '0', ''].includes(word)) return false
      throw new TransformError(field, `“${field}” should be yes or no, but the value was “${text(value).slice(0, 60)}”.`)
    }
  }
}

/** Builds the transformation's output. Throws TransformError when a value can't take its format. */
export function applyTransform(config: TransformConfig, scope: ResolutionScope): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const field of config.fields) {
    const raw = field.format === 'text' || field.format === 'lowercase' || field.format === 'uppercase' || field.format === 'trim' ? resolveText(field.value, scope).value : resolveTemplate(field.value, scope).value
    output[field.key] = format(raw, field.format, field.key)
  }
  return output
}

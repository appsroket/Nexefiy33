// Data mappings between steps. A templated value may contain references:
//
//   {{inputs.<key>}}                        a run input
//   {{steps.<node id>.output.<path…>}}      an earlier step's output
//   {{run.id}} / {{run.startedAt}}          facts about the run
//
// References are parsed by this restricted grammar and resolved by walking
// plain data: no expressions, no functions, no code execution. A value that
// is exactly one reference keeps its type (a number stays a number); anything
// else is text with the references filled in. Pure and Zod-free.

import { KEY_PATTERN, NODE_ID_PATTERN } from './types'

export type Reference =
  | { kind: 'input'; key: string; raw: string }
  | { kind: 'step'; nodeId: string; path: string[]; raw: string }
  | { kind: 'run'; field: 'id' | 'startedAt'; raw: string }

export interface ReferenceError {
  raw: string
  message: string
}

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

export function parseReference(body: string): Reference | ReferenceError {
  const raw = `{{${body}}}`
  const parts = body.split('.')
  switch (parts[0]) {
    case 'inputs':
      if (parts.length !== 2 || !KEY_PATTERN.test(parts[1]!)) return { raw, message: `${raw} should look like {{inputs.name}}.` }
      return { kind: 'input', key: parts[1]!, raw }
    case 'steps':
      if (parts.length < 3 || !NODE_ID_PATTERN.test(parts[1]!) || parts[2] !== 'output' || !parts.slice(3).every((part) => SEGMENT.test(part))) {
        return { raw, message: `${raw} should look like {{steps.step_id.output.field}}.` }
      }
      return { kind: 'step', nodeId: parts[1]!, path: parts.slice(3), raw }
    case 'run':
      if (parts.length === 2 && (parts[1] === 'id' || parts[1] === 'startedAt')) return { kind: 'run', field: parts[1], raw }
      return { raw, message: `${raw}: only {{run.id}} and {{run.startedAt}} exist.` }
    default:
      return { raw, message: `${raw} isn’t a reference Nexefiy understands. Use {{inputs.…}}, {{steps.….output.…}} or {{run.…}}.` }
  }
}

export function isReferenceError(value: Reference | ReferenceError): value is ReferenceError {
  return 'message' in value
}

/** Every reference in a template, valid or not. */
export function referencesIn(template: string): (Reference | ReferenceError)[] {
  return [...template.matchAll(TOKEN)].map((match) => parseReference(match[1]!.trim()))
}

/** Unclosed or stray braces, which would otherwise be sent as literal text. */
export function hasStrayBraces(template: string): boolean {
  return /\{\{|\}\}/.test(template.replace(TOKEN, ''))
}

export interface ResolutionScope {
  inputs: Record<string, unknown>
  steps: Record<string, { output: unknown }>
  run: { id: string; startedAt: string }
}

function walk(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined
      current = current[Number(segment)]
    } else if (typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return current
}

export function lookup(reference: Reference, scope: ResolutionScope): unknown {
  switch (reference.kind) {
    case 'input':
      return scope.inputs[reference.key]
    case 'run':
      return scope.run[reference.field]
    case 'step': {
      const step = scope.steps[reference.nodeId]
      return step ? walk(step.output, reference.path) : undefined
    }
  }
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export interface Resolved {
  value: unknown
  /** References that had no value (resolved to empty). */
  missing: string[]
  /** References that aren't valid (left out). */
  invalid: string[]
}

export function resolveTemplate(template: string, scope: ResolutionScope): Resolved {
  const missing: string[] = []
  const invalid: string[] = []
  const whole = template.match(/^\s*\{\{\s*([^{}]*?)\s*\}\}\s*$/)
  if (whole) {
    const reference = parseReference(whole[1]!.trim())
    if (isReferenceError(reference)) return { value: '', missing, invalid: [reference.raw] }
    const value = lookup(reference, scope)
    if (value === undefined || value === null) missing.push(reference.raw)
    return { value: value ?? '', missing, invalid }
  }
  const value = template.replace(TOKEN, (_match, body: string) => {
    const reference = parseReference(body.trim())
    if (isReferenceError(reference)) {
      invalid.push(reference.raw)
      return ''
    }
    const found = lookup(reference, scope)
    if (found === undefined || found === null) missing.push(reference.raw)
    return asText(found)
  })
  return { value, missing, invalid }
}

export function resolveText(template: string, scope: ResolutionScope): Resolved & { value: string } {
  const resolved = resolveTemplate(template, scope)
  return { ...resolved, value: asText(resolved.value) }
}

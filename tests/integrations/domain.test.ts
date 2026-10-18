// Pure rules of the integration framework: approval decisions, policy
// matching, retry decisions, error normalization helpers and fingerprints.

import { describe, expect, it } from 'vitest'

import { findAction, CONNECTORS, rateLimitRuleFor, requestedScopes, summarizeConnector } from '@/modules/integrations/connectors/registry'
import { IntegrationError, parseRetryAfter, safeProviderText } from '@/modules/integrations/domain/errors'
import { allowedApprovalModes, decideAction, evaluatePolicies, mostRestrictive } from '@/modules/integrations/domain/policy'
import { backoffDelayMs, decideRetry } from '@/modules/integrations/domain/retry'
import { actionFingerprint, canonicalJson } from '@/modules/integrations/server/executor'

describe('approval decisions', () => {
  it('takes the most restrictive mode', () => {
    expect(mostRestrictive('allow', 'require_approval')).toBe('require_approval')
    expect(mostRestrictive('require_approval', 'deny', 'allow')).toBe('deny')
    expect(mostRestrictive(null, undefined)).toBe('allow')
  })

  it('uses the declared default when no setting is stored', () => {
    expect(decideAction({ requirement: 'none', risk: 'read', connectionMode: null, enabled: true, policy: null }).decision).toBe('allow')
    expect(decideAction({ requirement: 'default_required', risk: 'write_external', connectionMode: null, enabled: true, policy: null }).decision).toBe(
      'require_approval',
    )
  })

  it('lets an admin relax a default requirement but never an "always" one or a sensitive action', () => {
    expect(decideAction({ requirement: 'default_required', risk: 'write_external', connectionMode: 'allow', enabled: true, policy: null }).decision).toBe('allow')
    expect(decideAction({ requirement: 'always', risk: 'write_external', connectionMode: 'allow', enabled: true, policy: null }).decision).toBe('require_approval')
    expect(decideAction({ requirement: 'none', risk: 'sensitive', connectionMode: 'allow', enabled: true, policy: null }).decision).toBe('require_approval')
    expect(allowedApprovalModes('always', 'write_external')).toEqual(['require_approval', 'deny'])
  })

  it('lets a policy make an action stricter, never looser', () => {
    const policy = { effect: 'require_approval' as const, policyId: 'p1', policyName: 'Default' }
    const stricter = decideAction({ requirement: 'none', risk: 'read', connectionMode: 'allow', enabled: true, policy })
    expect(stricter).toMatchObject({ decision: 'require_approval', policyId: 'p1', reason: expect.stringContaining('Default') })
    const looser = decideAction({ requirement: 'default_required', risk: 'write_external', connectionMode: null, enabled: true, policy: { ...policy, effect: 'allow' } })
    expect(looser.decision).toBe('require_approval')
  })

  it('blocks a disabled action whatever else applies', () => {
    expect(decideAction({ requirement: 'none', risk: 'read', connectionMode: 'allow', enabled: false, policy: null }).decision).toBe('deny')
  })
})

describe('organization policies', () => {
  const policies = [
    { id: 'p1', name: 'Slack review', rules: [{ effect: 'require_approval' as const, toolKeys: ['slack.*'] }] },
    { id: 'p2', name: 'No notes', rules: [{ effect: 'deny' as const, toolKeys: ['hubspot.notes.create'] }] },
    { id: 'p3', name: 'Conditional allow', rules: [{ effect: 'allow' as const, riskLevels: ['write_external' as const], conditions: { hours: 'business' } }] },
  ]

  it('matches exact keys, prefixes and risk levels, keeping the strictest', () => {
    expect(evaluatePolicies(policies, { toolKey: 'slack.messages.post', risk: 'write_external' })).toMatchObject({ effect: 'require_approval', policyId: 'p1' })
    expect(evaluatePolicies(policies, { toolKey: 'hubspot.notes.create', risk: 'write_external' })).toMatchObject({ effect: 'deny', policyId: 'p2' })
    expect(evaluatePolicies(policies, { toolKey: 'hubspot.contacts.search', risk: 'read' })).toBeNull()
  })

  it('never uses a rule with unevaluated conditions to allow', () => {
    expect(evaluatePolicies([policies[2]!], { toolKey: 'hubspot.contacts.upsert', risk: 'write_external' })).toBeNull()
  })

  it('restricts rules to listed employees', () => {
    const scoped = [{ id: 'p4', name: 'Employee', rules: [{ effect: 'deny' as const, employeeIds: ['e1'] }] }]
    expect(evaluatePolicies(scoped, { toolKey: 'slack.messages.post', risk: 'write_external', employeeId: 'e1' })).not.toBeNull()
    expect(evaluatePolicies(scoped, { toolKey: 'slack.messages.post', risk: 'write_external' })).toBeNull()
  })
})

describe('retries', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 }
  const readOnly = { kind: 'read_only' as const }
  const notIdempotent = { kind: 'not_idempotent' as const, description: '' }

  it('backs off exponentially within the cap', () => {
    expect([1, 2, 3, 6].map((attempt) => backoffDelayMs(policy, attempt))).toEqual([500, 1000, 2000, 5000])
  })

  it('retries transient failures until attempts run out', () => {
    expect(decideRetry(new IntegrationError('unavailable'), 1, policy, readOnly)).toMatchObject({ retry: true, delayMs: 500 })
    expect(decideRetry(new IntegrationError('unavailable'), 3, policy, readOnly).retry).toBe(false)
    expect(decideRetry(new IntegrationError('invalid_input'), 1, policy, readOnly).retry).toBe(false)
  })

  it('honours Retry-After, but not beyond the policy', () => {
    expect(decideRetry(new IntegrationError('rate_limited', { retryAfterMs: 3_000 }), 1, policy, readOnly)).toMatchObject({ retry: true, delayMs: 3_000 })
    expect(decideRetry(new IntegrationError('rate_limited', { retryAfterMs: 60_000 }), 1, policy, readOnly).retry).toBe(false)
  })

  it('never resends a non-idempotent action that may have reached the provider', () => {
    expect(decideRetry(new IntegrationError('unavailable'), 1, policy, notIdempotent).retry).toBe(false)
    expect(decideRetry(new IntegrationError('timeout'), 1, policy, notIdempotent).retry).toBe(false)
    expect(decideRetry(new IntegrationError('unavailable', { mayHaveReachedProvider: false }), 1, policy, notIdempotent).retry).toBe(true)
    expect(decideRetry(new IntegrationError('rate_limited', { retryAfterMs: 1000 }), 1, policy, notIdempotent).retry).toBe(true)
  })
})

describe('errors', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter('Sun, 18 Oct 2026 12:00:05 GMT', Date.parse('2026-10-18T12:00:00Z'))).toBe(5000)
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })

  it('removes credentials from provider text and caps its length', () => {
    expect(safeProviderText('bad token Bearer abc.def.ghi here')).toBe('bad token Bearer [REDACTED] here')
    expect(safeProviderText(`x${'y'.repeat(600)}`)!.length).toBe(500)
    expect(new IntegrationError('forbidden', { message: 'xoxb-not-a-real-token leaked' }).message).toBe('[REDACTED] leaked')
  })

  it('serializes without secrets and records whether the request may have arrived', () => {
    const error = new IntegrationError('rate_limited', { httpStatus: 429, retryAfterMs: 1000, providerCode: 'TEN_SECONDLY_ROLLING' })
    expect(error.toJSON()).toEqual({ code: 'rate_limited', message: expect.any(String), retryable: true, httpStatus: 429, providerCode: 'TEN_SECONDLY_ROLLING', retryAfterMs: 1000 })
    expect(error.mayHaveReachedProvider).toBe(false)
    expect(new IntegrationError('unavailable').mayHaveReachedProvider).toBe(true)
  })
})

describe('fingerprints', () => {
  it('ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
    expect(actionFingerprint('slack.messages.post', 'i1', { text: 'Hi', channel: 'C1' })).toBe(
      actionFingerprint('slack.messages.post', 'i1', { channel: 'C1', text: 'Hi' }),
    )
  })

  it('changes with the action, the connection or the input', () => {
    const base = actionFingerprint('slack.messages.post', 'i1', { channel: 'C1', text: 'Hi' })
    expect(actionFingerprint('slack.messages.post', 'i2', { channel: 'C1', text: 'Hi' })).not.toBe(base)
    expect(actionFingerprint('slack.messages.post', 'i1', { channel: 'C1', text: 'Hi!' })).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('connector declarations', () => {
  it('declares every required property for every action', () => {
    for (const connector of CONNECTORS) {
      expect(connector.rateLimits[connector.defaultRateLimitBucket]).toBeDefined()
      for (const action of connector.actions) {
        expect(action.key.startsWith(`${connector.provider}.`), action.key).toBe(true)
        expect(action.key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
        expect(action.scopes.length, action.key).toBeGreaterThan(0)
        expect(action.timeoutMs).toBeGreaterThan(0)
        expect(action.retry.maxAttempts).toBeGreaterThanOrEqual(1)
        expect(rateLimitRuleFor(connector, action.rateLimitBucket), action.key).toBeDefined()
        expect(action.input.safeParse(action.exampleInput).success, `${action.key} example input`).toBe(true)
        // Writes to other systems must not run unapproved by default.
        if (action.risk !== 'read') expect(action.approval).not.toBe('none')
        if (action.risk === 'read') expect(action.idempotency.kind).toBe('read_only')
      }
    }
  })

  it('requests only the scopes its actions use (plus HubSpot’s required oauth scope)', () => {
    expect(requestedScopes(CONNECTORS.find((connector) => connector.provider === 'hubspot')!)).toEqual(['oauth', 'crm.objects.contacts.read', 'crm.objects.contacts.write'])
    expect(requestedScopes(CONNECTORS.find((connector) => connector.provider === 'slack')!)).toEqual(['channels:read', 'chat:write'])
  })

  it('summarizes connectors for pages with JSON schemas of inputs', () => {
    const summary = summarizeConnector(CONNECTORS[0]!, false)
    expect(summary.configured).toBe(false)
    expect(summary.actions[0]!.inputSchema).toMatchObject({ type: 'object' })
    expect(findAction('slack.messages.post')?.connector.provider).toBe('slack')
    expect(findAction('gmail.send')).toBeUndefined()
  })
})

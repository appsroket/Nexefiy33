// Governance rules that need no database: how actions are classified, how
// policies combine into limits, allowlists and data-access restrictions,
// what blocks activation, the policy editor's schema, and the static
// guarantees that nothing an AI employee runs can decide an approval.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { listEmployeeTools } from '@/modules/employees/server/tools'
import { handoffControls } from '@/modules/governance/domain/controls'
import {
  activationPolicyIssues,
  allowlistBlocking,
  combineControls,
  effectiveKnowledgeAccess,
  effectiveLimits,
  storedPolicyFromRow,
  type StoredPolicy,
} from '@/modules/governance/domain/policy'
import { ACTION_CATEGORIES, ACTION_CATEGORY_INFO, isConsequential, RISK_TIER_INFO, RISK_TIERS, roleAtLeast, tierOf } from '@/modules/governance/domain/risk'
import { policyDocumentSchema, retentionSchema } from '@/modules/governance/domain/schemas'
import { CONNECTORS } from '@/modules/integrations/connectors/registry'

const policy = (id: string, document: StoredPolicy['document'], extra: Partial<StoredPolicy> = {}): StoredPolicy => ({
  id,
  name: id,
  revision: 1,
  schemaVersion: 2,
  authorizedRole: 'admin',
  document,
  ...extra,
})

describe('risk classification', () => {
  it('classifies every action Nexefiy can take, and the examples from the brief', () => {
    for (const connector of CONNECTORS) for (const action of connector.actions) expect(ACTION_CATEGORIES, action.key).toContain(action.category)
    expect(listEmployeeTools().every((tool) => ACTION_CATEGORIES.includes(tool.category))).toBe(true)
    // Drafting a message, modifying CRM records, sending external messages,
    // issuing refunds, changing payroll, deleting important data.
    expect(tierOf('draft')).toBe('low')
    expect(tierOf('record_change')).toBe('medium')
    expect(tierOf('external_message')).toBe('high')
    expect(tierOf('financial')).toBe('critical')
    expect(tierOf('personnel')).toBe('critical')
    expect(tierOf('destructive')).toBe('critical')
    expect(ACTION_CATEGORY_INFO.financial.examples.join(' ')).toMatch(/refund/i)
    expect(ACTION_CATEGORY_INFO.personnel.examples.join(' ')).toMatch(/payroll/i)
  })

  it('maps the real connectors to their categories', () => {
    const category = (key: string) => CONNECTORS.flatMap((connector) => connector.actions).find((action) => action.key === key)?.category
    expect(category('hubspot.contacts.search')).toBe('read')
    expect(category('hubspot.contacts.upsert')).toBe('record_change')
    expect(category('hubspot.notes.create')).toBe('record_change')
    expect(category('slack.channels.list')).toBe('read')
    expect(category('slack.messages.post')).toBe('external_message')
  })

  it('makes every tier above low consequential, with stricter terms as risk rises', () => {
    expect(ACTION_CATEGORIES.filter(isConsequential)).toEqual(['internal_update', 'record_change', 'external_message', 'financial', 'personnel', 'destructive'])
    const hours = RISK_TIERS.map((tier) => RISK_TIER_INFO[tier].maxApprovalHours)
    expect([...hours].sort((a, b) => b - a)).toEqual(hours)
    expect(RISK_TIER_INFO.critical).toMatchObject({ approverRole: 'owner', authorizerRole: 'owner', separateApprover: true })
    // Categories without a connector say so (the website and docs must not claim them).
    expect(ACTION_CATEGORIES.filter((category) => !ACTION_CATEGORY_INFO[category].available)).toEqual(['financial', 'personnel', 'destructive'])
    expect(roleAtLeast('admin', 'operator')).toBe(true)
    expect(roleAtLeast(null, 'operator')).toBe(false)
  })
})

describe('combining policies', () => {
  it('takes the smallest limit, every allowlist, and the union of blocked sources', () => {
    const controls = combineControls([
      policy('a', { rules: [], limits: { maxCostUsdPerTask: 2, organizationMonthlyUsd: 500 }, tools: { allowlist: ['hubspot.*', 'knowledge.search'] }, dataAccess: { blockedSourceIds: ['s1'] } }),
      policy('b', { rules: [], limits: { maxCostUsdPerTask: 1, maxTaskRuntimeSeconds: 60 }, tools: { allowlist: ['*'] }, dataAccess: { blockedSourceIds: ['s2'], requireSelectedSources: true } }),
      policy('v1', { rules: [], defaults: { approvalExpiresInHours: 8 } }, { schemaVersion: 1 }),
    ])
    expect(controls.limits).toEqual({ maxCostUsdPerTask: 1, organizationMonthlyUsd: 500, maxTaskRuntimeSeconds: 60 })
    expect(controls.blockedSourceIds.sort()).toEqual(['s1', 's2'])
    expect(controls.requireSelectedSources).toBe(true)
    expect(controls.approvals.expiresInHours).toBe(8)
    expect(allowlistBlocking(controls, 'hubspot.contacts.upsert')).toBeNull()
    expect(allowlistBlocking(controls, 'slack.messages.post')).toBe('a')
  })

  it('narrows knowledge access and limits, never widens them', () => {
    const controls = combineControls([policy('p', { rules: [], dataAccess: { blockedSourceIds: ['s1'] }, limits: { maxTaskRuntimeSeconds: 30, maxCostUsdPerTask: 5 } })])
    expect(effectiveKnowledgeAccess({ access: 'all', sourceIds: [] }, controls)).toMatchObject({ access: 'all', excludeSourceIds: ['s1'] })
    expect(effectiveKnowledgeAccess({ access: 'selected', sourceIds: ['s1', 's2'] }, controls)).toMatchObject({ access: 'selected', sourceIds: ['s2'] })
    expect(effectiveKnowledgeAccess({ access: 'selected', sourceIds: ['s1'] }, controls)).toMatchObject({ access: 'none' })
    expect(effectiveKnowledgeAccess({ access: 'none', sourceIds: [] }, controls).access).toBe('none')
    expect(effectiveKnowledgeAccess({ access: 'all', sourceIds: [] }, { blockedSourceIds: [], requireSelectedSources: true }).access).toBe('none')
    expect(effectiveLimits({ maxRuntimeSeconds: 120, maxCostUsdPerTask: 1, maxTurnsPerTask: 10 }, controls)).toEqual({ maxRuntimeSeconds: 30, maxCostUsdPerTask: 1, maxTurnsPerTask: 10 })
  })

  it('lists what stops a configuration from being activated', () => {
    const controls = combineControls([policy('Allowed', { rules: [], tools: { allowlist: ['knowledge.search'] }, dataAccess: { requireSelectedSources: true } })])
    expect(activationPolicyIssues({ tools: [{ toolKey: 'knowledge.search' }, { toolKey: 'slack.messages.post' }], knowledge: { access: 'all', sourceIds: [] } }, controls)).toEqual([
      'Workspace policy “Allowed” doesn’t allow slack.messages.post.',
      'Workspace policy requires employees to name the knowledge sources they read.',
    ])
    expect(activationPolicyIssues({ tools: [{ toolKey: 'knowledge.search' }], knowledge: { access: 'selected', sourceIds: ['s1'] } }, controls)).toEqual([])
  })

  it('reads stored rows defensively: an unknown authorizing role authorizes nothing', () => {
    expect(storedPolicyFromRow({ id: 'p', name: 'P', policy: null, authorized_role: 'operator' })).toMatchObject({ authorizedRole: null, revision: 1, schemaVersion: 1, document: { rules: [] } })
  })
})

describe('the policy editor schema', () => {
  it('accepts a full version 2 document', () => {
    const parsed = policyDocumentSchema.safeParse({
      rules: [
        { effect: 'allow', toolKeys: ['hubspot.contacts.upsert'], actors: ['employee'] },
        { effect: 'require_approval', categories: ['external_message'], approverRole: 'owner', separateApprover: true, approvalExpiresInHours: 4 },
        { effect: 'deny', tiers: ['critical'], employeeIds: ['a2000000-0000-4000-8000-000000000001'] },
      ],
      approvals: { expiresInHours: 24, separateApprover: true },
      tools: { allowlist: ['hubspot.*', 'knowledge.search'] },
      dataAccess: { blockedSourceIds: ['a3000000-0000-4000-8000-000000000001'], requireSelectedSources: false },
      limits: { maxTaskRuntimeSeconds: 120, maxCostUsdPerTask: 0.5, employeeMonthlyUsd: 50, organizationMonthlyUsd: 1000 },
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses vague allows, misplaced approval settings, unknown fields and out-of-range limits', () => {
    expect(policyDocumentSchema.safeParse({ rules: [{ effect: 'allow', categories: ['record_change'] }] }).success).toBe(false)
    expect(policyDocumentSchema.safeParse({ rules: [{ effect: 'deny', approverRole: 'owner' }] }).success).toBe(false)
    expect(policyDocumentSchema.safeParse({ rules: [], conditions: {} }).success).toBe(false)
    expect(policyDocumentSchema.safeParse({ rules: [{ effect: 'deny', toolKeys: ['DROP TABLE'] }] }).success).toBe(false)
    expect(policyDocumentSchema.safeParse({ rules: [], limits: { maxTaskRuntimeSeconds: 5 } }).success).toBe(false)
    expect(retentionSchema.safeParse({ evidenceDays: 7, eventDays: null, payloadDays: null, hold: false }).success).toBe(false)
    expect(retentionSchema.safeParse({ evidenceDays: null, eventDays: 90, payloadDays: 365, hold: true }).success).toBe(true)
  })

  it('matches the database validator’s vocabulary', () => {
    const sql = readFileSync('supabase/migrations/20261021090000_governance_controls.sql', 'utf8')
    for (const category of ACTION_CATEGORIES) expect(sql).toContain(`"${category}"`)
    for (const key of ['maxTaskRuntimeSeconds', 'maxCostUsdPerTask', 'employeeMonthlyUsd', 'organizationMonthlyUsd', 'blockedSourceIds', 'requireSelectedSources', 'allowlist', 'separateApprover']) {
      expect(sql).toContain(`"${key}"`)
    }
  })
})

describe('handoff controls', () => {
  const base = { handedOffTo: null, handedOffAt: null, viewerId: 'u1', viewerRole: 'operator' as const, isEmployeeTask: true }
  it('lets operators take over unfinished, non-running employee tasks, and only the taker or an admin complete them', () => {
    expect(handoffControls({ ...base, status: 'blocked' })).toEqual({ takeOver: true, complete: false })
    expect(handoffControls({ ...base, status: 'running' }).takeOver).toBe(false)
    expect(handoffControls({ ...base, status: 'succeeded' }).takeOver).toBe(false)
    expect(handoffControls({ ...base, status: 'blocked', viewerRole: 'viewer' }).takeOver).toBe(false)
    const taken = { ...base, status: 'blocked', handedOffAt: '2026-10-19T10:00:00Z', handedOffTo: 'u2' }
    expect(handoffControls(taken)).toEqual({ takeOver: false, complete: false })
    expect(handoffControls({ ...taken, viewerId: 'u2' }).complete).toBe(true)
    expect(handoffControls({ ...taken, viewerRole: 'admin' }).complete).toBe(true)
  })
})

describe('an AI employee cannot approve', () => {
  const sources = readdirSync('src', { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))

  it('has no tool that decides approvals or changes governance', () => {
    for (const tool of listEmployeeTools()) expect(tool.key, tool.key).not.toMatch(/approv|polic|governance|emergency|permission|audit/)
  })

  it('decides approvals only through decide_approval, called from a person’s server action', () => {
    const callers = sources.filter((file) => /rpc\('decide_approval'/.test(readFileSync(file, 'utf8')))
    expect(callers).toEqual([join('src', 'modules', 'governance', 'server', 'approval-actions.ts')])
    expect(readFileSync(callers[0]!, 'utf8')).toMatch(/createUserClient/)
    // Nothing writes an approval's decision directly.
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      expect(/from\('approval_requests'\)[\s\S]{0,200}\.update\(\{[^}]*status: 'approved'/.test(text), file).toBe(false)
    }
  })
})

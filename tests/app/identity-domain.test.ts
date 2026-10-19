import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ORGANIZATION_ROLES, type OrganizationRole } from '@/lib/supabase/types'
import { authCallbackUrl, authErrorMessage, GENERIC_AUTH_ERROR, safeNextPath, signInNotice } from '@/modules/identity/domain/auth'
import { effectiveInvitationStatus, invitationLink, isInvitationToken } from '@/modules/identity/domain/invitations'
import { invitableRoles, memberPermissions } from '@/modules/identity/domain/members'
import { onboardingProgress } from '@/modules/identity/domain/onboarding'
import { routeForSession } from '@/modules/identity/domain/routing'
import {
  changePasswordSchema,
  companyDetailsSchema,
  inviteSchema,
  newPasswordSchema,
  signUpSchema,
  workspaceSchema,
} from '@/modules/identity/domain/schemas'
import { deleteConfirmationMatches, slugify } from '@/modules/identity/domain/workspace'
import { buildInvitationEmail } from '@/modules/identity/server/invitation-delivery'

const TOKEN = 'ab'.repeat(32)
const BASE = 'http://localhost:3000'

describe('redirects after sign-in and email links', () => {
  it.each([
    ['/app', '/app'],
    ['/app/settings/members', '/app/settings/members'],
    ['/invite', '/invite'],
    ['/reset-password', '/reset-password'],
  ])('allows the in-app path %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected)
  })

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/app/../../evil',
    '/appx',
    '/app?next=https://evil.example',
    '/app/%2F%2Fevil',
    '/pricing',
    'javascript:alert(1)',
    '',
  ])('falls back to the app for %s', (input) => {
    expect(safeNextPath(input)).toBe('/app')
  })

  it('ignores non-strings', () => {
    expect(safeNextPath(null)).toBe('/app')
    expect(safeNextPath(['/app/settings'])).toBe('/app')
  })

  it('builds the callback URL from the configured app URL with a safe next path', () => {
    expect(authCallbackUrl(BASE, '/reset-password')).toBe(`${BASE}/auth/callback?next=%2Freset-password`)
    expect(authCallbackUrl(BASE, 'https://evil.example')).toBe(`${BASE}/auth/callback?next=%2Fapp`)
  })
})

describe('proxy routing', () => {
  const route = (path: string, signedIn: boolean) => routeForSession(new URL(path, BASE), signedIn)?.toString() ?? null

  it('sends signed-out visitors from the app to sign-in, remembering where they were going', () => {
    expect(route('/app', false)).toBe(`${BASE}/sign-in`)
    expect(route('/app/settings/members', false)).toBe(`${BASE}/sign-in?next=%2Fapp%2Fsettings%2Fmembers`)
    expect(route('/app', true)).toBeNull()
  })

  it('sends signed-in people away from sign-in and sign-up, honouring a safe next path only', () => {
    expect(route('/sign-in', true)).toBe(`${BASE}/app`)
    expect(route('/sign-up?next=/invite', true)).toBe(`${BASE}/invite`)
    expect(route('/sign-in?next=https://evil.example', true)).toBe(`${BASE}/app`)
    expect(route('/sign-in', false)).toBeNull()
  })

  it('requires the reset-link session for the new-password page', () => {
    expect(route('/reset-password', false)).toBe(`${BASE}/forgot-password?expired=1`)
    expect(route('/reset-password', true)).toBeNull()
  })

  it('finishes an email link that fell back to the site URL', () => {
    expect(route('/?code=abc', false)).toBe(`${BASE}/auth/callback?code=abc&next=%2Fapp`)
    expect(route('/', false)).toBeNull()
  })
})

describe('account validation', () => {
  const valid = { fullName: ' Sam Lee ', email: ' Sam@Example.COM ', password: 'correct horse' }

  it('normalizes name and email', () => {
    expect(signUpSchema.parse(valid)).toEqual({ fullName: 'Sam Lee', email: 'sam@example.com', password: 'correct horse' })
  })

  it('rejects short passwords and passwords over 72 bytes (bcrypt’s limit), counting bytes not characters', () => {
    expect(signUpSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false)
    expect(signUpSchema.safeParse({ ...valid, password: 'a'.repeat(72) }).success).toBe(true)
    expect(signUpSchema.safeParse({ ...valid, password: 'é'.repeat(37) }).success).toBe(false)
  })

  it('requires the repeated password to match', () => {
    const result = newPasswordSchema.safeParse({ password: 'a long password', confirmPassword: 'a long passw0rd' })
    expect(result.error?.issues[0]?.path).toEqual(['confirmPassword'])
    expect(changePasswordSchema.safeParse({ currentPassword: '', password: 'a long password', confirmPassword: 'a long password' }).success).toBe(false)
  })

  it('translates Supabase Auth error codes and never echoes unknown ones', () => {
    expect(authErrorMessage('invalid_credentials')).toMatch(/incorrect/)
    expect(authErrorMessage('some_new_code')).toBe(GENERIC_AUTH_ERROR)
    expect(authErrorMessage(undefined)).toBe(GENERIC_AUTH_ERROR)
    expect(authErrorMessage('toString')).toBe(GENERIC_AUTH_ERROR)
    expect(signInNotice('link')).toMatch(/expired/)
    expect(signInNotice('toString')).toBeNull()
  })
})

describe('workspaces', () => {
  it('suggests an address from the name', () => {
    expect(slugify('Acme Café Ltd.')).toBe('acme-cafe-ltd')
    expect(slugify('  --Hello   World--  ')).toBe('hello-world')
    expect(slugify('AB')).toBe('ab-workspace')
    expect(slugify('日本')).toBe('')
    expect(slugify('x'.repeat(80))).toHaveLength(48)
  })

  it('accepts only addresses the database accepts', () => {
    expect(workspaceSchema.safeParse({ name: 'Acme', slug: 'Acme-Co' }).data?.slug).toBe('acme-co')
    for (const slug of ['ab', '-acme', 'acme-', 'ac me', 'a'.repeat(49)]) {
      expect(workspaceSchema.safeParse({ name: 'Acme', slug }).success, slug).toBe(false)
    }
  })

  it('normalizes company details', () => {
    const parsed = companyDetailsSchema.parse({ legalName: '  ', website: 'example.com', timezone: 'Europe/Paris' })
    expect(parsed).toMatchObject({ legalName: null, website: 'https://example.com', description: null })
    expect(companyDetailsSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(companyDetailsSchema.safeParse({ timezone: 'UTC', website: 'http://' }).success).toBe(false)
  })

  it('requires the exact address to confirm deletion', () => {
    expect(deleteConfirmationMatches(' ACME-co ', 'acme-co')).toBe(true)
    expect(deleteConfirmationMatches('acme', 'acme-co')).toBe(false)
    expect(deleteConfirmationMatches(null, 'acme-co')).toBe(false)
  })
})

describe('member permissions mirror the database rules', () => {
  const me = (role: OrganizationRole) => ({ userId: 'me', role })
  const them = (role: OrganizationRole) => ({ userId: 'them', role })

  it('owners manage everyone except the last owner', () => {
    expect(memberPermissions(me('owner'), them('admin'), 1)).toEqual({ roleOptions: [...ORGANIZATION_ROLES].reverse(), canRemove: true })
    expect(memberPermissions(me('owner'), them('owner'), 2).canRemove).toBe(true)
    expect(memberPermissions(me('owner'), { userId: 'me', role: 'owner' }, 1)).toEqual({ roleOptions: [], canRemove: false })
    expect(memberPermissions(me('owner'), { userId: 'me', role: 'owner' }, 2).roleOptions).toHaveLength(4)
  })

  it('admins manage only operators and viewers, and can’t promote to admin', () => {
    expect(memberPermissions(me('admin'), them('operator'), 1)).toEqual({ roleOptions: ['operator', 'viewer'], canRemove: true })
    expect(memberPermissions(me('admin'), them('admin'), 1)).toEqual({ roleOptions: [], canRemove: false })
    expect(memberPermissions(me('admin'), them('owner'), 1)).toEqual({ roleOptions: [], canRemove: false })
    expect(memberPermissions({ userId: 'them', role: 'admin' }, them('admin'), 1).roleOptions).toEqual([])
  })

  it('operators and viewers manage nobody', () => {
    for (const role of ['operator', 'viewer'] as const) {
      for (const target of ORGANIZATION_ROLES) {
        expect(memberPermissions(me(role), them(target), 1)).toEqual({ roleOptions: [], canRemove: false })
      }
    }
  })

  it('owners invite admins; admins invite operators and viewers; others invite nobody', () => {
    expect(invitableRoles('owner')).toEqual(['admin', 'operator', 'viewer'])
    expect(invitableRoles('admin')).toEqual(['operator', 'viewer'])
    expect(invitableRoles('operator')).toEqual([])
  })
})

describe('invitations', () => {
  it('validates tokens and roles', () => {
    expect(isInvitationToken(TOKEN)).toBe(true)
    expect(isInvitationToken(TOKEN.toUpperCase())).toBe(false)
    expect(isInvitationToken(`${TOKEN}0`)).toBe(false)
    expect(inviteSchema.safeParse({ email: 'a@example.com', role: 'owner' }).success).toBe(false)
    expect(inviteSchema.parse({ email: ' A@Example.com ', role: 'viewer' }).email).toBe('a@example.com')
  })

  it('treats a pending invitation past its expiry as expired', () => {
    const now = new Date('2026-10-18T12:00:00Z')
    expect(effectiveInvitationStatus('pending', '2026-10-18T11:59:59Z', now)).toBe('expired')
    expect(effectiveInvitationStatus('pending', '2026-10-19T00:00:00Z', now)).toBe('pending')
    expect(effectiveInvitationStatus('revoked', '2026-10-19T00:00:00Z', now)).toBe('revoked')
  })

  it('puts the token in the URL fragment, which browsers never send to servers', () => {
    const link = new URL(invitationLink(BASE, TOKEN))
    expect(link.pathname).toBe('/invite')
    expect(link.search).toBe('')
    expect(link.hash).toBe(`#${TOKEN}`)
  })

  it('builds a plain-text email whose subject can’t carry injected headers', () => {
    const email = buildInvitationEmail(
      {
        to: 'new@example.com',
        token: TOKEN,
        organizationName: 'Acme\r\nBcc: attacker@example.com',
        inviterName: 'Sam <b>Lee</b>',
        role: 'operator',
        expiresAt: '2026-10-25T12:00:00Z',
      },
      { from: 'Nexefiy <team@mail.example.com>', appUrl: BASE },
    )
    expect(Object.keys(email).sort()).toEqual(['from', 'subject', 'text', 'to'])
    expect(email.subject).not.toMatch(/[\r\n]/)
    expect(email.text).toContain(`${BASE}/invite#${TOKEN}`)
    expect(email.text).toContain('as operator')
    expect(email.to).toEqual(['new@example.com'])
  })
})

describe('onboarding progress', () => {
  it('counts only steps that can be done today, and only for roles that can do them', () => {
    const owner = onboardingProgress({ role: 'owner', hasName: true, hasCompanyDetails: false, hasInvitedSomeone: true })
    expect(owner.steps.map((step) => step.id)).toEqual(['workspace', 'profile', 'company', 'team', 'employee', 'integration'])
    expect([owner.completed, owner.total]).toEqual([3, 4])
    expect(owner.steps.filter((step) => step.status === 'planned').map((step) => step.id)).toEqual(['employee', 'integration'])

    const viewer = onboardingProgress({ role: 'viewer', hasName: false, hasCompanyDetails: true, hasInvitedSomeone: true })
    expect(viewer.steps.map((step) => step.id)).toEqual(['workspace', 'profile', 'employee', 'integration'])
    expect([viewer.completed, viewer.total]).toEqual([1, 2])
  })
})

describe('browser bundle hygiene', () => {
  // Client components may import these, so they must stay free of Zod (about 60 kB).
  const ZOD_FREE = [
    'src/lib/forms/action-state.ts',
    'src/modules/analytics/domain/calculations.ts',
    'src/modules/analytics/domain/evidence.ts',
    'src/modules/analytics/domain/metrics.ts',
    'src/modules/analytics/domain/outcomes.ts',
    'src/modules/analytics/domain/period.ts',
    'src/modules/identity/domain/auth.ts',
    'src/modules/identity/domain/invitations.ts',
    'src/modules/identity/domain/members.ts',
    'src/modules/identity/domain/onboarding.ts',
    'src/modules/identity/domain/workspace.ts',
    'src/modules/knowledge/domain/business-context.ts',
    'src/modules/knowledge/domain/chunking.ts',
    'src/modules/knowledge/domain/company-profile.ts',
    'src/modules/knowledge/domain/context-kinds.ts',
    'src/modules/knowledge/domain/evidence.ts',
    'src/modules/knowledge/domain/files.ts',
    'src/modules/integrations/domain/errors.ts',
    'src/modules/integrations/domain/policy.ts',
    'src/modules/integrations/domain/retry.ts',
    'src/modules/integrations/domain/types.ts',
    'src/modules/integrations/ui/labels.ts',
    'src/modules/governance/domain/controls.ts',
    'src/modules/governance/domain/policy.ts',
    'src/modules/governance/domain/risk.ts',
    'src/modules/employees/domain/capabilities.ts',
    'src/modules/employees/domain/defaults.ts',
    'src/modules/employees/domain/lifecycle.ts',
    'src/modules/employees/domain/prompt.ts',
    'src/modules/employees/domain/rule-drafter.ts',
    'src/modules/employees/domain/skills.ts',
    'src/modules/employees/domain/templates.ts',
    'src/modules/employees/domain/test-checks.ts',
    'src/modules/employees/domain/types.ts',
    'src/modules/employees/domain/validation.ts',
    'src/modules/employees/ui/labels.ts',
    'src/modules/models/domain/catalog.ts',
    'src/modules/tasks/domain/failures.ts',
    'src/modules/tasks/domain/labels.ts',
    'src/modules/tasks/domain/task-center.ts',
    'src/modules/tasks/domain/untrusted.ts',
    'src/modules/tasks/domain/verification.ts',
    'src/modules/workflows/domain/execution.ts',
    'src/modules/workflows/domain/factory.ts',
    'src/modules/workflows/domain/graph.ts',
    'src/modules/workflows/domain/logic.ts',
    'src/modules/workflows/domain/references.ts',
    'src/modules/workflows/domain/rule-drafter.ts',
    'src/modules/workflows/domain/schedule.ts',
    'src/modules/workflows/domain/types.ts',
    'src/modules/workflows/domain/validation.ts',
    'src/modules/workflows/ui/labels.ts',
  ]

  it('keeps Zod out of modules that client components import', () => {
    for (const file of ZOD_FREE) expect(readFileSync(file, 'utf8'), file).not.toMatch(/from 'zod'/)
  })

  it('never imports Zod or the form schemas from a client component', () => {
    const files = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
    const clientFiles = files.filter((file) => /^['"]use client['"]/m.test(readFileSync(file, 'utf8')))
    expect(clientFiles.length).toBeGreaterThan(10)
    for (const file of clientFiles) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from '(zod|@\/lib\/forms\/parse-form|[^']*domain\/schemas|[^']*contact-schema)'/)
    }
  })
})

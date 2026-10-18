import { describe, expect, it } from 'vitest'

import { listHref, parseListParams } from '@/lib/list-params'
import { findNavItem, isNavItemActive, NAV_ITEMS } from '@/modules/app-shell/domain/navigation'
import { initials, resolveActiveWorkspace, rolesAtOrBelow, type WorkspaceMembership } from '@/modules/app-shell/domain/workspace'

const ws = (id: string, name: string): WorkspaceMembership => ({ organizationId: id, name, slug: id, role: 'viewer' })

describe('navigation', () => {
  it('has unique hrefs', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length)
  })
  it('matches overview only at the root and sections by segment', () => {
    expect(isNavItemActive({ href: '/app' }, '/app/approvals')).toBe(false)
    expect(isNavItemActive({ href: '/app/approvals' }, '/app/approvals/123')).toBe(true)
    expect(isNavItemActive({ href: '/app/approvals' }, '/app/approvalsx')).toBe(false)
    expect(findNavItem('/app/settings/')?.href).toBe('/app/settings')
    expect(findNavItem('/pricing')).toBeUndefined()
  })
})

describe('workspace selection', () => {
  const list = [ws('b', 'Beta'), ws('a', 'Acme')]
  it('uses the remembered workspace only when the user is a member', () => {
    expect(resolveActiveWorkspace(list, 'b')?.organizationId).toBe('b')
    expect(resolveActiveWorkspace(list, 'someone-elses-org')?.organizationId).toBe('a')
    expect(resolveActiveWorkspace([], 'a')).toBeNull()
  })
  it('lists roles at or below a role', () => {
    expect(rolesAtOrBelow('operator')).toEqual(['viewer', 'operator'])
  })
  it('builds initials', () => {
    expect(initials('Acme Corp')).toBe('AC')
    expect(initials('sam.lee@example.com')).toBe('S')
    expect(initials('')).toBe('?')
  })
})

describe('list params', () => {
  const spec = {
    sortable: ['created_at', 'name'],
    defaultSort: { column: 'created_at', direction: 'desc' },
    filters: { status: ['pending', 'approved'] },
    pageSize: 10,
  } as const
  it('falls back to defaults for invalid input', () => {
    const state = parseListParams({ sort: 'password', dir: 'sideways', status: 'evil', page: '-3' }, spec)
    expect(state.sort).toEqual({ column: 'created_at', direction: 'desc' })
    expect(state.filters).toEqual({})
    expect(state.page).toBe(1)
  })
  it('computes ranges and keeps allowed filters', () => {
    const state = parseListParams({ status: 'approved', page: '3', q: '  hi ' }, spec)
    expect([state.from, state.to, state.q, state.filters.status]).toEqual([20, 29, 'hi', 'approved'])
  })
  it('resets the page when other params change', () => {
    expect(listHref('/x', { page: '4', q: 'a' }, { sort: 'name' })).toBe('/x?q=a&sort=name')
    expect(listHref('/x', { q: 'a' }, { page: 2 })).toBe('/x?q=a&page=2')
  })
})

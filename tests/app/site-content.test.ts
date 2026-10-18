// Public website: every page exists, every internal link resolves, and the
// copy makes no claims the product can't back up.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import robots from '@/app/robots'
import sitemap from '@/app/sitemap'
import { resetEnvironmentCache } from '@/lib/env/server'
import { APP_HOME, NAV_ITEMS } from '@/modules/app-shell/domain/navigation'
import { ALL_CAPABILITIES } from '@/modules/marketing/domain/capabilities'
import { parseTopicParam } from '@/modules/marketing/domain/contact'
import { EMPLOYEE_CATEGORIES, HIGHLIGHTED_CATEGORY_IDS } from '@/modules/marketing/domain/employees'
import { SECURITY_TOPICS } from '@/modules/marketing/domain/security'
import { EARLY_ACCESS_HREF, FOOTER_NAV, HEADER_NAV, isSiteLinkActive, PUBLIC_PAGES } from '@/modules/marketing/domain/site'
import { USE_CASES } from '@/modules/marketing/domain/use-cases'
import { pageMetadata } from '@/modules/marketing/ui/page-metadata'

import { CORE_VARS } from '../helpers/env-fixtures'

const ROOT = join(import.meta.dirname, '..', '..')
const SITE_DIR = join(ROOT, 'src', 'app', '(site)')
const APP_DIR = join(ROOT, 'src', 'app', 'app')

function filesUnder(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return filesUnder(path, test)
    return test(name) ? [path] : []
  })
}

/** Page file that serves a public path, e.g. "/legal/terms" → (site)/legal/terms/page.tsx. */
const sitePageFile = (path: string) => join(SITE_DIR, ...path.split('/').filter(Boolean), 'page.tsx')
const appPageFile = (path: string) => join(APP_DIR, ...path.replace(/^\/app/, '').split('/').filter(Boolean), 'page.tsx')

const PUBLIC_PATHS = new Set<string>(Object.values(PUBLIC_PAGES).map((page) => page.path))
const APP_PATHS = new Set(NAV_ITEMS.map((item) => item.href))

const WEBSITE_SOURCES = [
  ...filesUnder(SITE_DIR, (name) => /\.tsx?$/.test(name)),
  ...filesUnder(join(ROOT, 'src', 'modules', 'marketing'), (name) => /\.tsx?$/.test(name)),
  join(ROOT, 'src', 'app', 'not-found.tsx'),
]
const read = (path: string) => readFileSync(path, 'utf8')

describe('public pages', () => {
  it('has a page file for every public page', () => {
    for (const path of PUBLIC_PATHS) expect(existsSync(sitePageFile(path)), path).toBe(true)
  })

  it('lists every page file in PUBLIC_PAGES (no unlisted pages)', () => {
    const files = filesUnder(SITE_DIR, (name) => name === 'page.tsx')
    const paths = files.map((file) => {
      const segments = relative(SITE_DIR, file).split(/[\\/]/).slice(0, -1)
      return `/${segments.join('/')}`
    })
    expect(paths.sort()).toEqual([...PUBLIC_PATHS].sort())
  })

  it('leaves "/" to the website: the application lives under /app', () => {
    expect(APP_HOME).toBe('/app')
    for (const href of APP_PATHS) expect(href === APP_HOME || href.startsWith(`${APP_HOME}/`), href).toBe(true)
    for (const href of APP_PATHS) expect(existsSync(appPageFile(href)), href).toBe(true)
  })

  it('links every header and footer item to a public page', () => {
    const links = [...HEADER_NAV, ...FOOTER_NAV.flatMap((group) => group.links)]
    for (const link of links) expect(PUBLIC_PATHS, link.href).toContain(link.href)
    // Every public page is reachable from the header, the footer, the account buttons, or (for the
    // account pages below) the sign-in form and the links in account emails.
    const reachable = new Set([
      ...links.map((link) => link.href),
      '/',
      PUBLIC_PAGES.signIn.path,
      PUBLIC_PAGES.signUp.path,
      PUBLIC_PAGES.forgotPassword.path,
      PUBLIC_PAGES.resetPassword.path,
      PUBLIC_PAGES.invite.path,
    ])
    for (const path of PUBLIC_PATHS) expect(reachable, path).toContain(path)
  })

  it('matches header links to the current page', () => {
    expect(isSiteLinkActive('/', '/pricing')).toBe(false)
    expect(isSiteLinkActive('/pricing', '/pricing/')).toBe(true)
    expect(isSiteLinkActive('/legal', '/legal/terms')).toBe(true)
    expect(isSiteLinkActive('/use-cases', '/use-cases-old')).toBe(false)
  })
})

describe('internal links', () => {
  const hrefs = WEBSITE_SOURCES.flatMap((file) =>
    [...read(file).matchAll(/href(?:=\{?|:\s*)["'`](\/[^"'`\s]*)["'`]/g)].map((match) => ({
      file: relative(ROOT, file),
      href: match[1]!,
    })),
  )
  hrefs.push({ file: 'site.ts', href: EARLY_ACCESS_HREF })

  it('finds the links it checks', () => {
    expect(hrefs.length).toBeGreaterThan(10)
  })

  it.each(hrefs)('$href in $file resolves', ({ href }) => {
    const url = new URL(href, 'http://site.test')
    const known = PUBLIC_PATHS.has(url.pathname) || APP_PATHS.has(url.pathname)
    expect(known, `unknown page ${url.pathname}`).toBe(true)

    const topic = url.searchParams.get('topic')
    if (topic !== null) {
      expect(url.pathname).toBe(PUBLIC_PAGES.contact.path)
      expect(parseTopicParam(topic), `unknown topic ${topic}`).toBeDefined()
    }

    if (url.hash) {
      const target = read(sitePageFile(url.pathname))
      const id = url.hash.slice(1)
      expect(target, `no element with id ${id} on ${url.pathname}`).toMatch(new RegExp(`id=["{']+${id}["}']`))
    }
  })
})

describe('honest content', () => {
  const sources = WEBSITE_SOURCES.map((file) => ({ file: relative(ROOT, file), text: read(file) }))

  // Patterns for claims the website must not make (see the prompt for this
  // phase and CLAUDE.md rule 1). Extend rather than relax.
  const FORBIDDEN: [string, RegExp][] = [
    ['testimonials', /testimonial|what (our )?customers say|customers love|case stud/i],
    ['customer logos', /trusted by|used by (teams|companies|businesses)|our customers include|logo ?(wall|cloud|strip)/i],
    ['integration counts', /\b\d+\s*\+?\s*(integrations|apps|connectors|tools)\b/i],
    ['customer counts', /\b\d[\d,]*\s*\+?\s*(customers|businesses|companies|teams|users)\b/i],
    // A currency sign before a number, but not a regex replacement like '$1'.
    ['prices', /(?<!['"`])[$€£]\s?\d/],
    ['outcome metrics', /\b\d+\s*(%|x)\s*(faster|more|less|fewer|increase|reduction|saved|roi)\b/i],
    ['hours saved', /\bsave[sd]?\s+\d+\s+hours\b/i],
  ]

  it.each(FORBIDDEN)('makes no %s claims', (_label, pattern) => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(pattern)
  })

  it('names certifications only to say they are not held', () => {
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/SOC 2|ISO 27001|HIPAA|GDPR[- ]compliant|PCI/g)) {
        const sentence = text.slice(Math.max(0, match.index! - 120), match.index! + 40)
        expect(sentence, file).toMatch(/holds no|not (been )?certified|no security certifications/i)
      }
    }
  })

  // Each "Built" claim must point at the code or tests that make it true.
  const BUILT_EVIDENCE: Record<string, string> = {
    'credential-encryption': 'src/lib/crypto/credential-encryption.ts',
    'approvals-list': 'src/app/app/approvals/page.tsx',
    'workspace-isolation': 'supabase/tests/database/002_tenant_isolation.test.sql',
    'workspace-interface': 'src/modules/app-shell/ui/app-shell.tsx',
    accounts: 'supabase/tests/database/005_auth_workspace_flow.test.sql',
    'Database-enforced workspace isolation': 'supabase/tests/database/002_tenant_isolation.test.sql',
    'Automated isolation tests': 'supabase/tests/database/003_roles_and_membership.test.sql',
    'Four roles': 'supabase/tests/database/003_roles_and_membership.test.sql',
    'Activity and audit history': 'supabase/migrations/20261017220022_governance.sql',
    'Encrypted connected-app credentials': 'tests/crypto/credential-encryption.test.ts',
    'No secret keys in the browser': 'scripts/check-bundle.ts',
    'Secrets kept out of logs': 'tests/logging/redact.test.ts',
  }

  it('backs every "Built" capability and security measure with evidence in the repository', () => {
    const built = [
      ...ALL_CAPABILITIES.filter((item) => item.status === 'built').map((item) => item.id),
      ...SECURITY_TOPICS.flatMap((topic) => topic.measures)
        .filter((measure) => measure.status === 'built')
        .map((measure) => measure.title),
    ]
    expect(built.length).toBeGreaterThan(0)
    for (const key of built) {
      expect(BUILT_EVIDENCE[key], `no evidence recorded for "${key}"`).toBeDefined()
      expect(existsSync(join(ROOT, BUILT_EVIDENCE[key]!)), BUILT_EVIDENCE[key]).toBe(true)
    }
  })

  it('marks every AI employee category and use case as planned (none is built yet)', () => {
    for (const item of [...EMPLOYEE_CATEGORIES, ...USE_CASES]) expect(item.status, item.id).not.toBe('built')
  })

  it('shows the six requested categories on the home page', () => {
    const names = HIGHLIGHTED_CATEGORY_IDS.map((id) => EMPLOYEE_CATEGORIES.find((category) => category.id === id)?.name)
    expect(names).toEqual(['Sales', 'Voice', 'Marketing', 'Customer Support', 'Analytics', 'Operations'])
  })

  it('marks every legal page as an unreviewed draft', () => {
    for (const path of ['/legal/terms', '/legal/privacy', '/legal/acceptable-use']) {
      expect(read(sitePageFile(path)), path).toContain('<LegalDocument')
      expect(pageMetadata(path === '/legal/terms' ? 'terms' : path === '/legal/privacy' ? 'privacy' : 'acceptableUse').robots).toEqual({
        index: false,
        follow: true,
      })
    }
    expect(read(join(ROOT, 'src/modules/marketing/ui/legal-document.tsx'))).toMatch(/not been reviewed by a lawyer, is not in effect/)
  })
})

describe('search engine metadata', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    for (const [name, value] of Object.entries(CORE_VARS)) vi.stubEnv(name, value)
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nexefiy.example')
    resetEnvironmentCache()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvironmentCache()
  })

  it('keeps account and draft pages out of search results', () => {
    expect(pageMetadata('signIn').robots).toEqual({ index: false, follow: true })
    expect(pageMetadata('pricing').robots).toBeUndefined()
    expect(pageMetadata('pricing').alternates?.canonical).toBe('/pricing')
  })

  it('lists only indexable pages, as absolute URLs, in the sitemap', () => {
    vi.stubEnv('APP_ENV', 'production')
    const urls = sitemap().map((entry) => entry.url)
    expect(urls).toContain('https://nexefiy.example/')
    expect(urls).toContain('https://nexefiy.example/security')
    expect(urls.some((url) => /sign-|legal|\/app/.test(url))).toBe(false)
  })

  it('allows crawling only in production, and never the application', () => {
    vi.stubEnv('APP_ENV', 'preview')
    resetEnvironmentCache()
    expect(robots().rules).toEqual({ userAgent: '*', disallow: '/' })

    vi.stubEnv('APP_ENV', 'production')
    resetEnvironmentCache()
    const production = robots()
    expect(production.rules).toMatchObject({ allow: '/', disallow: expect.arrayContaining(['/app']) })
    expect(production.sitemap).toBe('https://nexefiy.example/sitemap.xml')
  })
})

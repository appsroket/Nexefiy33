// Static checks on the SQL migrations. They complement the pgTAP suite in
// supabase/tests (which runs against a real database) and run with npm test.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS } from '@/lib/config/embeddings'
import { ORGANIZATION_ROLES } from '@/lib/supabase/types'

import { TEST_DIR, withFixtures } from '../../scripts/db/fixtures'

const root = join(import.meta.dirname, '../..')
const migrationDir = join(root, 'supabase/migrations')
const files = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()
const sql = files.map((name) => readFileSync(join(migrationDir, name), 'utf8')).join('\n')
const types = readFileSync(join(root, 'src/lib/supabase/database.types.ts'), 'utf8')

const createdTables = [...sql.matchAll(/^create table public\.(\w+)/gm)].map((match) => match[1]!)

describe('migration files', () => {
  it('follow the Supabase CLI naming convention with increasing versions', () => {
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) expect(name).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/)
    const versions = files.map((name) => name.slice(0, 14))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('enable row level security on every table they create', () => {
    for (const table of createdTables) {
      expect(sql, table).toMatch(new RegExp(`alter table public\\.${table} enable row level security`))
    }
  })

  it('revoke default client privileges on every table they create', () => {
    const revoked = [...sql.matchAll(/revoke all on ([^;]+?)\s+from anon, authenticated/g)]
      .flatMap((match) => match[1]!.split(','))
      .map((name) => name.trim().replace(/^public\./, ''))
    for (const table of createdTables) expect(revoked, table).toContain(table)
  })

  it('pin search_path on every function', () => {
    const functions = sql.split(/^create function /m).slice(1)
    expect(functions.length).toBeGreaterThan(0)
    for (const body of functions) {
      const name = body.slice(0, body.indexOf('('))
      expect(body.slice(0, body.indexOf('$$')), name).toContain("set search_path = ''")
    }
  })

  it('store embeddings with the configured model dimension', () => {
    expect(sql).toContain(`embedding extensions.vector(${EMBEDDING_DIMENSIONS})`)
    expect(sql).toContain(`p_query_embedding extensions.vector(${EMBEDDING_DIMENSIONS})`)
  })

  it('keep the role list in sync with the database', () => {
    expect(sql).toContain("role in ('owner', 'admin', 'operator', 'viewer')")
    expect([...ORGANIZATION_ROLES].sort()).toEqual(['admin', 'operator', 'owner', 'viewer'])
  })
})

describe('generated database types', () => {
  it('include every table created by the migrations', () => {
    for (const table of createdTables) expect(types, table).toMatch(new RegExp(`^      ${table}: \\{$`, 'm'))
  })
})

describe('pgTAP test files', () => {
  it('contain the current copy of their shared fixtures (run npm run db:test:sync)', () => {
    const testFiles = readdirSync(join(root, TEST_DIR)).filter((name) => name.endsWith('.sql'))
    expect(testFiles.length).toBeGreaterThanOrEqual(4)
    for (const name of testFiles) {
      const source = readFileSync(join(root, TEST_DIR, name), 'utf8').replace(/\r\n/g, '\n')
      expect(withFixtures(source, root), name).toBe(source)
    }
  })

  it('each run inside a transaction that is rolled back', () => {
    for (const name of readdirSync(join(root, TEST_DIR)).filter((file) => file.endsWith('.sql'))) {
      const source = readFileSync(join(root, TEST_DIR, name), 'utf8')
      expect(source.trimStart().split('\n').find((line) => !line.startsWith('--')), name).toBe('begin;')
      expect(source.trimEnd().endsWith('rollback;'), name).toBe(true)
    }
  })
})

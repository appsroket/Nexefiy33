import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { CORE_VARS, FEATURE_VARS, fixtureSecretValues, fullEnv } from '../helpers/env-fixtures'

const root = resolve(import.meta.dirname, '../..')
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const script = join(root, 'scripts', 'check-env.ts')
// Run from an empty directory so the developer's own .env.local is not read.
const cwd = mkdtempSync(join(tmpdir(), 'nexefiy-env-check-'))

afterAll(() => rmSync(cwd, { recursive: true, force: true }))

function run(env: Record<string, string | undefined>, args: string[] = []) {
  const blankFeatureVars = Object.fromEntries(
    Object.values(FEATURE_VARS).flatMap((vars) => Object.keys(vars).map((name) => [name, ''])),
  )
  const result = spawnSync(process.execPath, [tsx, script, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: 'test',
      ...blankFeatureVars,
      SUPABASE_SERVICE_ROLE_KEY: '',
      OPENAI_API_KEY: '',
      APP_ENV: 'development',
      ...env,
    },
    timeout: 60_000,
  })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('npm run env:check', () => {
  it('succeeds with core only and lists disabled features with setup links', () => {
    const { code, output } = run(CORE_VARS as Record<string, string>)
    expect(code).toBe(0)
    expect(output).toContain('✔ Core application')
    expect(output).toContain('○ AI model provider — not configured')
    expect(output).toContain('setup: docs/credential-setup.md#b-ai-model-provider')
  }, 60_000)

  it('fails with a clear message when core configuration is missing', () => {
    const { code, output } = run({ NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' })
    expect(code).toBe(1)
    expect(output).toContain('NEXT_PUBLIC_SUPABASE_URL is required')
  }, 60_000)

  it('never prints secret values', () => {
    const { code, output } = run(fullEnv() as Record<string, string>)
    expect(code).toBe(0)
    expect(output).toContain('14 configured')
    for (const secret of fixtureSecretValues()) expect(output).not.toContain(secret)
  }, 60_000)

  it('exits non-zero in --strict mode when a feature is misconfigured', () => {
    const { code, output } = run({ ...(CORE_VARS as Record<string, string>), RESEND_API_KEY: 're_fffffffffff' }, [
      '--strict',
    ])
    expect(code).toBe(1)
    expect(output).toContain('missing: EMAIL_FROM')
  }, 60_000)
})

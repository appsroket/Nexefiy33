import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import { describe, expect, it } from 'vitest'

import { ENV_VARS } from '@/lib/env/catalog'
import { parseEnvironment } from '@/lib/env/core'
import { looksLikeSecretValue } from '@/lib/env/validators'

const example = parseEnv(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'))

describe('.env.example', () => {
  it('documents every variable in the catalog', () => {
    for (const variable of ENV_VARS) expect(Object.keys(example), variable.name).toContain(variable.name)
  })

  it('contains placeholders only — every secret is blank', () => {
    for (const variable of ENV_VARS.filter((v) => v.secret)) {
      expect(example[variable.name], variable.name).toBe('')
    }
    for (const [name, value] of Object.entries(example)) {
      expect(looksLikeSecretValue(value ?? ''), name).toBe(false)
    }
  })

  it('boots with core placeholders and every optional feature cleanly not configured', () => {
    const { features } = parseEnvironment(example)
    for (const feature of Object.values(features)) {
      expect(feature.state, feature.key).toBe(feature.key === 'core' ? 'configured' : 'not_configured')
    }
  })
})

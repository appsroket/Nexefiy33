import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { ENV_VARS, FEATURES } from '@/lib/env/catalog'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

/** GitHub's heading anchor algorithm (sufficient for our ASCII headings). */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-')

describe('credential docs stay in sync with the catalog', () => {
  const setupGuide = read('docs/credential-setup.md')
  const anchors = new Set([...setupGuide.matchAll(/^#{2,3} (.+)$/gm)].map((match) => slug(match[1]!)))

  it.each(Object.values(FEATURES).map((f) => [f.key, f.guide] as const))('%s guide link resolves', (_key, guide) => {
    const [file, anchor] = guide.split('#')
    expect(file).toBe('docs/credential-setup.md')
    expect(anchors).toContain(anchor)
  })

  it('documents every variable in the environment reference', () => {
    const reference = read('docs/environment-variables.md')
    for (const variable of ENV_VARS) expect(reference, variable.name).toContain(`\`${variable.name}\``)
  })
})

// Copies supabase/test-fixtures/*.sql into the marked regions of every pgTAP
// test file. Run after editing a fixture: npm run db:test:sync

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEST_DIR, withFixtures } from './fixtures'

const root = process.cwd()
for (const file of readdirSync(join(root, TEST_DIR)).filter((name) => name.endsWith('.sql'))) {
  const path = join(root, TEST_DIR, file)
  const source = readFileSync(path, 'utf8')
  const updated = withFixtures(source, root)
  if (updated !== source) {
    writeFileSync(path, updated)
    console.log(`updated ${file}`)
  }
}

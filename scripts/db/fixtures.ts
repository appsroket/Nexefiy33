// pgTAP files must be self-contained (each runs in its own transaction), so the
// shared fixture is copied into every test file between marker comments:
//
//   -- BEGIN FIXTURE two_organizations
//   …copied from supabase/test-fixtures/two_organizations.sql…
//   -- END FIXTURE two_organizations

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TEST_DIR = 'supabase/tests/database'
export const FIXTURE_DIR = 'supabase/test-fixtures'
const MARKER = /^-- BEGIN FIXTURE (\S+)\n[\s\S]*?^-- END FIXTURE \1$/gm

const normalize = (text: string) => text.replace(/\r\n/g, '\n')

export function readFixture(root: string, name: string): string {
  return normalize(readFileSync(join(root, FIXTURE_DIR, `${name}.sql`), 'utf8')).trimEnd()
}

/** Returns the test source with every fixture region replaced by the current fixture. */
export function withFixtures(testSource: string, root: string): string {
  return normalize(testSource).replace(
    MARKER,
    (_match, name: string) => `-- BEGIN FIXTURE ${name}\n${readFixture(root, name)}\n-- END FIXTURE ${name}`,
  )
}

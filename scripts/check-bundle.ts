// Scans the production build for anything secret that reached the browser:
// credential-shaped strings, the actual secret values from local env files,
// and names of server-only variables (a sign server code was bundled).
//
// Usage: npm run build && npm run check:bundle

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseEnv } from 'node:util'

import { ENV_VARS } from '../src/lib/env/catalog'

const ROOT = process.cwd()
const CLIENT_DIR = join(ROOT, '.next', 'static')
const PRERENDERED_DIR = join(ROOT, '.next', 'server', 'app')

const CREDENTIAL_PATTERNS: [string, RegExp][] = [
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['Stripe secret/restricted key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/],
  ['Stripe webhook secret', /whsec_[A-Za-z0-9]{10,}/],
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/],
  ['Trigger.dev secret key', /\btr_(?:dev|prod|stg|preview)_[A-Za-z0-9]{10,}/],
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{10,}/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
]

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g

function filesUnder(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return filesUnder(path, extensions)
    return extensions.some((ext) => name.endsWith(ext)) ? [path] : []
  })
}

function localSecretValues(): Map<string, string> {
  const secretNames = new Set(ENV_VARS.filter((v) => v.secret).map((v) => v.name))
  const values = new Map<string, string>()
  for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const path = join(ROOT, file)
    if (!existsSync(path)) continue
    for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
      if (secretNames.has(name) && value && value.length >= 8) values.set(name, value)
    }
  }
  return values
}

function serviceRoleJwt(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    return payload?.role === 'service_role'
  } catch {
    return false
  }
}

const clientFiles = filesUnder(CLIENT_DIR, ['.js', '.css', '.html', '.json'])
if (clientFiles.length === 0) {
  console.error('No build output found in .next/static. Run `npm run build` first.')
  process.exit(2)
}
const files = [...clientFiles, ...filesUnder(PRERENDERED_DIR, ['.html', '.rsc'])]
const secrets = localSecretValues()
const serverOnlyNames = ENV_VARS.filter((v) => v.exposure !== 'public').map((v) => v.name)

const findings: string[] = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const where = relative(ROOT, file)
  for (const [label, pattern] of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) findings.push(`${where}: looks like a ${label}`)
  }
  for (const token of text.match(JWT) ?? []) {
    if (serviceRoleJwt(token)) findings.push(`${where}: contains a service_role JWT`)
  }
  for (const [name, value] of secrets) {
    if (text.includes(value)) findings.push(`${where}: contains the value of ${name}`)
  }
  // Variable names only matter in browser code: they mean the server env module was bundled.
  if (file.startsWith(CLIENT_DIR)) {
    for (const name of serverOnlyNames) {
      if (text.includes(name)) findings.push(`${where}: references server-only variable ${name}`)
    }
  }
}

if (findings.length) {
  // Report locations and kinds only; never print the matched text.
  console.error(`Bundle check FAILED (${findings.length} finding${findings.length === 1 ? '' : 's'}):`)
  for (const finding of findings) console.error(`  - ${finding}`)
  process.exit(1)
}
console.log(
  `Bundle check passed: ${files.length} files scanned (${clientFiles.length} browser assets), ` +
    `${secrets.size} local secret value(s) checked, no secrets or server-only variables found.`,
)

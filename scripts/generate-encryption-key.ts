// Prints a new keyring entry for INTEGRATION_ENCRYPTION_KEYS.
//   npm run env:generate-key            -> key id based on today's date
//   npm run env:generate-key -- k2027a  -> explicit key id
// Paste the output into your secret store / .env.local; it is not saved anywhere.

import { generateEncryptionKey, KEY_ID_PATTERN } from '../src/lib/crypto/keyring'

const keyId = process.argv[2] ?? `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`

if (!KEY_ID_PATTERN.test(keyId)) {
  console.error('Key id must be 1–32 letters, digits, "_" or "-".')
  process.exit(1)
}

console.log(`${keyId}:${generateEncryptionKey()}`)
console.error(
  [
    '',
    'Next steps:',
    '  1. Prepend this entry to INTEGRATION_ENCRYPTION_KEYS (comma-separated).',
    `  2. Set INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID=${keyId}.`,
    '  3. Store a backup in your password/secret manager before deploying.',
    '  See docs/credential-setup.md#e1-customer-credential-encryption for rotation.',
  ].join('\n'),
)

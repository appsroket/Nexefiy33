// Parsing for the customer-credential encryption keyring.
// Kept free of `server-only` so the env check script can validate it; the
// encryption functions themselves live in credential-encryption.ts.

import { randomBytes } from 'node:crypto'

export const KEY_BYTES = 32
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** A new random 32-byte key, base64 encoded, for INTEGRATION_ENCRYPTION_KEYS. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64')
}

export interface Keyring {
  activeKeyId: string
  keys: ReadonlyMap<string, Buffer>
}

export class KeyringError extends Error {
  override name = 'KeyringError'
}

/**
 * Parses `INTEGRATION_ENCRYPTION_KEYS` ("id1:base64,id2:base64") and the active key id.
 * Error messages identify entries by key id or position only — never by key material.
 */
export function parseKeyring(serialized: string, activeKeyId: string): Keyring {
  const keys = new Map<string, Buffer>()
  const entries = serialized
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (entries.length === 0) throw new KeyringError('keyring is empty')

  entries.forEach((entry, index) => {
    const separator = entry.indexOf(':')
    if (separator <= 0) {
      throw new KeyringError(`entry #${index + 1} is not in "keyId:base64Key" form`)
    }
    const id = entry.slice(0, separator)
    const encoded = entry.slice(separator + 1)
    if (!KEY_ID_PATTERN.test(id)) {
      throw new KeyringError(`entry #${index + 1} has an invalid key id (use 1–32 letters, digits, "_" or "-")`)
    }
    if (keys.has(id)) throw new KeyringError(`key id "${id}" appears more than once`)
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
      throw new KeyringError(`key "${id}" is not valid base64`)
    }
    const key = Buffer.from(encoded, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new KeyringError(`key "${id}" must decode to ${KEY_BYTES} bytes`)
    }
    keys.set(id, key)
  })

  if (!keys.has(activeKeyId)) {
    throw new KeyringError(`active key id "${activeKeyId}" is not in the keyring`)
  }
  return { activeKeyId, keys }
}

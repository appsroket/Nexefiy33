// Authenticated encryption for customer integration credentials (OAuth access
// and refresh tokens, API keys customers give us). See ADR-014 and
// docs/credential-setup.md#e1-customer-credential-encryption.
//
// - AES-256-GCM, random 96-bit IV per encryption, 128-bit auth tag.
// - Envelope: "nxf1.<keyId>.<iv>.<ciphertext>.<tag>" (base64url parts), so the
//   key that encrypted a value is known and rotation can be incremental.
// - Additional authenticated data binds each ciphertext to its organization,
//   connection and purpose: a ciphertext copied to another row or tenant fails
//   to decrypt instead of silently yielding another customer's token.

import 'server-only'

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { Keyring } from './keyring'

const VERSION = 'nxf1'
const IV_BYTES = 12
const TAG_BYTES = 16

export interface CredentialContext {
  organizationId: string
  connectionId: string
  /** What the secret is, e.g. "oauth_tokens". */
  purpose: string
}

export class CredentialDecryptionError extends Error {
  override name = 'CredentialDecryptionError'
}

export function encryptCredential(keyring: Keyring, plaintext: string, context: CredentialContext): string {
  const key = keyring.keys.get(keyring.activeKeyId)
  if (!key) throw new CredentialDecryptionError('active encryption key is missing from the keyring')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(additionalData(keyring.activeKeyId, context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, keyring.activeKeyId, b64(iv), b64(ciphertext), b64(tag)].join('.')
}

export function decryptCredential(keyring: Keyring, envelope: string, context: CredentialContext): string {
  const { keyId, iv, ciphertext, tag } = parseEnvelope(envelope)
  const key = keyring.keys.get(keyId)
  if (!key) {
    throw new CredentialDecryptionError(
      `credential was encrypted with key "${keyId}", which is not in the keyring; restore that key or ask the customer to reconnect`,
    )
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(additionalData(keyId, context))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // Wrong key, tampered data, or a context mismatch (e.g. another org's row).
    throw new CredentialDecryptionError('credential failed authentication and cannot be decrypted')
  }
}

/** The key id an envelope was encrypted with (for rotation bookkeeping). */
export function credentialKeyId(envelope: string): string {
  return parseEnvelope(envelope).keyId
}

export function needsReencryption(keyring: Keyring, envelope: string): boolean {
  return credentialKeyId(envelope) !== keyring.activeKeyId
}

/** Decrypts with whichever key was used and re-encrypts with the active key. */
export function reencryptCredential(keyring: Keyring, envelope: string, context: CredentialContext): string {
  return encryptCredential(keyring, decryptCredential(keyring, envelope, context), context)
}

function additionalData(keyId: string, context: CredentialContext): Buffer {
  for (const [field, value] of Object.entries(context)) {
    if (!value || value.includes('|')) throw new CredentialDecryptionError(`invalid credential context field: ${field}`)
  }
  return Buffer.from(
    [VERSION, keyId, context.organizationId, context.connectionId, context.purpose].join('|'),
    'utf8',
  )
}

function parseEnvelope(envelope: string) {
  const parts = envelope.split('.')
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new CredentialDecryptionError('unrecognized credential envelope format')
  }
  const [, keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string]
  const decoded = { keyId, iv: unb64(iv), ciphertext: unb64(ciphertext), tag: unb64(tag) }
  if (decoded.iv.length !== IV_BYTES || decoded.tag.length !== TAG_BYTES) {
    throw new CredentialDecryptionError('malformed credential envelope')
  }
  return decoded
}

const b64 = (buffer: Buffer) => buffer.toString('base64url')
const unb64 = (value: string) => Buffer.from(value, 'base64url')

import { describe, expect, it } from 'vitest'

import {
  CredentialDecryptionError,
  credentialKeyId,
  decryptCredential,
  encryptCredential,
  needsReencryption,
  reencryptCredential,
} from '@/lib/crypto/credential-encryption'
import { generateEncryptionKey, KeyringError, parseKeyring } from '@/lib/crypto/keyring'

import { testKey } from '../helpers/env-fixtures'

const context = { organizationId: 'org-a', connectionId: 'conn-1', purpose: 'oauth_tokens' }
const secret = JSON.stringify({ access_token: 'fake-access', refresh_token: 'fake-refresh' })

describe('credential encryption', () => {
  const keyring = parseKeyring(`k1:${testKey(1)}`, 'k1')

  it('round-trips a credential', () => {
    const envelope = encryptCredential(keyring, secret, context)
    expect(envelope.startsWith('nxf1.k1.')).toBe(true)
    expect(envelope).not.toContain('fake-access')
    expect(decryptCredential(keyring, envelope, context)).toBe(secret)
  })

  it('uses a fresh IV for every encryption', () => {
    expect(encryptCredential(keyring, secret, context)).not.toBe(encryptCredential(keyring, secret, context))
  })

  it('detects tampering', () => {
    const parts = encryptCredential(keyring, secret, context).split('.')
    const ciphertext = Buffer.from(parts[3]!, 'base64url')
    ciphertext[0] = ciphertext[0]! ^ 0xff
    parts[3] = ciphertext.toString('base64url')
    expect(() => decryptCredential(keyring, parts.join('.'), context)).toThrow(CredentialDecryptionError)
  })

  it.each([
    ['another organization', { ...context, organizationId: 'org-b' }],
    ['another connection', { ...context, connectionId: 'conn-2' }],
    ['another purpose', { ...context, purpose: 'api_key' }],
  ])('refuses to decrypt in the context of %s', (_label, otherContext) => {
    const envelope = encryptCredential(keyring, secret, context)
    expect(() => decryptCredential(keyring, envelope, otherContext)).toThrow(CredentialDecryptionError)
  })

  it('does not reveal the plaintext or key in error messages', () => {
    const envelope = encryptCredential(keyring, secret, context)
    try {
      decryptCredential(keyring, envelope, { ...context, organizationId: 'org-b' })
    } catch (error) {
      expect((error as Error).message).not.toContain('fake-access')
      expect((error as Error).message).not.toContain(testKey(1))
    }
  })

  it('rejects malformed envelopes', () => {
    expect(() => decryptCredential(keyring, 'plaintext-token', context)).toThrow(/unrecognized credential envelope/)
    expect(() => decryptCredential(keyring, 'nxf1.k1.a.b.c', context)).toThrow(/malformed/)
  })
})

describe('key rotation', () => {
  const oldRing = parseKeyring(`k1:${testKey(1)}`, 'k1')
  const rotatedRing = parseKeyring(`k2:${testKey(2)},k1:${testKey(1)}`, 'k2')

  it('decrypts old ciphertexts after a new key becomes active', () => {
    const envelope = encryptCredential(oldRing, secret, context)
    expect(decryptCredential(rotatedRing, envelope, context)).toBe(secret)
    expect(needsReencryption(rotatedRing, envelope)).toBe(true)
  })

  it('re-encrypts with the active key', () => {
    const envelope = encryptCredential(oldRing, secret, context)
    const rotated = reencryptCredential(rotatedRing, envelope, context)
    expect(credentialKeyId(rotated)).toBe('k2')
    expect(needsReencryption(rotatedRing, rotated)).toBe(false)
    expect(decryptCredential(parseKeyring(`k2:${testKey(2)}`, 'k2'), rotated, context)).toBe(secret)
  })

  it('gives an actionable error when a retired key is still needed', () => {
    const envelope = encryptCredential(oldRing, secret, context)
    const withoutOld = parseKeyring(`k2:${testKey(2)}`, 'k2')
    expect(() => decryptCredential(withoutOld, envelope, context)).toThrow(/key "k1", which is not in the keyring/)
  })
})

describe('keyring parsing', () => {
  it.each([
    ['', 'k1', /keyring is empty/],
    ['k1', 'k1', /not in "keyId:base64Key" form/],
    [`bad.id:${testKey(1)}`, 'bad.id', /invalid key id/],
    [`k1:${testKey(1)},k1:${testKey(2)}`, 'k1', /appears more than once/],
    ['k1:%%%', 'k1', /not valid base64/],
    [`k1:${Buffer.alloc(16).toString('base64')}`, 'k1', /must decode to 32 bytes/],
    [`k1:${testKey(1)}`, 'k9', /active key id "k9" is not in the keyring/],
  ])('rejects %j (active %s)', (serialized, active, message) => {
    expect(() => parseKeyring(serialized, active)).toThrow(KeyringError)
    expect(() => parseKeyring(serialized, active)).toThrow(message)
  })

  it('generates 32-byte keys that the keyring accepts', () => {
    const key = generateEncryptionKey()
    expect(Buffer.from(key, 'base64')).toHaveLength(32)
    expect(parseKeyring(`new:${key}`, 'new').keys.get('new')).toHaveLength(32)
  })
})

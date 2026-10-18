import { describe, expect, it } from 'vitest'

import { redact, redactString } from '@/lib/logging/redact'

import { fake, legacySupabaseJwt } from '../helpers/env-fixtures'

describe('redact', () => {
  it('removes sensitive keys at any depth, case-insensitively', () => {
    const input = {
      provider: 'google',
      headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k', 'Content-Type': 'application/json' },
      body: { tokens: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
      list: [{ password: 'p', name: 'ok' }],
    }
    expect(redact(input)).toEqual({
      provider: 'google',
      headers: { Authorization: '[REDACTED]', 'X-Api-Key': '[REDACTED]', 'Content-Type': 'application/json' },
      body: { tokens: { access_token: '[REDACTED]', refresh_token: '[REDACTED]', expires_in: 3600 } },
      list: [{ password: '[REDACTED]', name: 'ok' }],
    })
  })

  it('does not mutate its input', () => {
    const input = { token: 'secret' }
    redact(input)
    expect(input.token).toBe('secret')
  })

  it.each([
    ['bearer header in text', 'request failed: Authorization: Bearer abc.def-123'],
    ['Supabase secret key', `key=${fake('sb_secret_')}`],
    ['Anthropic key', `using ${fake('sk-ant-')}`],
    ['Stripe live key', `stripe ${fake('sk_live_')}`],
    ['Stripe webhook secret', fake('whsec_')],
    ['Resend key', fake('re_')],
    ['Trigger.dev key', fake('tr_prod_')],
    ['Google client secret', fake('GOCSPX-')],
    ['Google access token', fake('ya29.')],
    ['Slack bot token', fake('xoxb-')],
    ['JWT', legacySupabaseJwt('service_role')],
    ['encrypted credential envelope', 'nxf1.k1.aaaa.bbbb.cccc'],
    ['token in a URL', 'https://example.com/cb?state=s&access_token=abc123&x=1'],
    ['OAuth code in a URL', 'https://app.example.com/callback?code=4/0Abc-def&state=xyz'],
  ])('scrubs a %s from strings', (_label, text) => {
    const result = redactString(text)
    expect(result).toContain('[REDACTED]')
    const secretPart = text.match(/(Bearer \S+|sb_secret_\w+|sk-ant-\w+|sk_live_\w+|whsec_\w+|re_\w+|tr_prod_\w+|GOCSPX-\w+|ya29\.\w+|xoxb-\w+|eyJ\S+|nxf1\.\S+|access_token=\w+|code=[^&]+)/)?.[0]
    if (secretPart) expect(result).not.toContain(secretPart.replace(/^(Bearer |access_token=|code=)/, ''))
  })

  it('keeps ordinary text intact', () => {
    expect(redactString('Workflow run 42 finished in 3.2s')).toBe('Workflow run 42 finished in 3.2s')
  })

  it('handles Errors, Headers, Maps, binary data, and cycles', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    const result = redact({
      error: new Error(`401 from provider with ${fake('sk-ant-')}`),
      headers: new Headers({ authorization: 'Bearer x', 'x-request-id': 'r1' }),
      map: new Map([['refresh_token', 'r']]),
      payload: Buffer.from('raw webhook body'),
      cyclic,
    })
    expect(result).toEqual({
      error: { name: 'Error', message: '401 from provider with [REDACTED]' },
      headers: { authorization: '[REDACTED]', 'x-request-id': 'r1' },
      map: { refresh_token: '[REDACTED]' },
      payload: '[Binary 16 bytes]',
      cyclic: { name: 'loop', self: '[Circular]' },
    })
  })
})

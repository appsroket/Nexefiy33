import { afterEach, describe, expect, it, vi } from 'vitest'

import { HONEYPOT_FIELD, parseTopicParam } from '@/modules/marketing/domain/contact'
import { contactMessageSchema } from '@/modules/marketing/domain/contact-schema'
import {
  buildContactEmail,
  CONTACT_SUCCESS_MESSAGE,
  CONTACT_UNAVAILABLE_MESSAGE,
  handleContactSubmission,
  RESEND_EMAILS_URL,
  type ContactDeps,
} from '@/modules/marketing/server/contact-service'
import { createRateLimiter } from '@/lib/rate-limit'

import { fake } from '../helpers/env-fixtures'

const API_KEY = fake('re_')
const CONFIG = { resendApiKey: API_KEY, from: 'Nexefiy <web@mail.example.com>', to: 'inbox@example.com' }
const SECRET_MESSAGE = 'Our private launch plan is attached in this message body.'

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(values)) data.set(name, value)
  return data
}

const VALID = { name: 'Sam Lee', email: 'sam@example.com', company: 'Example Ltd', topic: 'early-access', message: SECRET_MESSAGE }

function deps(overrides: Partial<ContactDeps> = {}) {
  const fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }))
  return { fetchMock, deps: { config: CONFIG, allowSubmission: () => true, fetch: fetchMock as unknown as typeof fetch, ...overrides } }
}

afterEach(() => vi.restoreAllMocks())

describe('contact form validation', () => {
  it('accepts a complete message and strips line breaks from single-line fields', () => {
    const result = contactMessageSchema.parse({ ...VALID, name: 'Sam\r\nBcc: attacker@example.com', company: undefined })
    expect(result.name).toBe('Sam Bcc: attacker@example.com')
    expect(result.company).toBe('')
  })

  it.each([
    ['name', { name: '   ' }],
    ['email', { email: 'not-an-email' }],
    ['topic', { topic: 'sales-pitch' }],
    ['message', { message: 'short' }],
    ['message', { message: 'x'.repeat(5001) }],
  ])('rejects an invalid %s', (field, change) => {
    const result = contactMessageSchema.safeParse({ ...VALID, ...change })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field)
  })

  it('accepts only known topics from the query string', () => {
    expect(parseTopicParam('security')).toBe('security')
    expect(parseTopicParam(['product', 'other'])).toBe('product')
    expect(parseTopicParam('<script>')).toBeUndefined()
    expect(parseTopicParam(undefined)).toBeUndefined()
  })
})

describe('contact form submission', () => {
  it('refuses while delivery is not configured, without calling the provider', async () => {
    const { deps: d, fetchMock } = deps({ config: null })
    expect(await handleContactSubmission(form(VALID), d)).toEqual({ status: 'error', message: CONTACT_UNAVAILABLE_MESSAGE })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns field errors for invalid input, without calling the provider', async () => {
    const { deps: d, fetchMock } = deps()
    const state = await handleContactSubmission(form({ ...VALID, email: 'nope' }), d)
    expect(state.status).toBe('error')
    expect(state.status === 'error' && state.fieldErrors?.email).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('quietly drops submissions that fill the honeypot', async () => {
    const { deps: d, fetchMock } = deps()
    expect(await handleContactSubmission(form({ ...VALID, [HONEYPOT_FIELD]: 'https://spam.example' }), d)).toEqual({
      status: 'success',
      message: CONTACT_SUCCESS_MESSAGE,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when the sender is rate limited', async () => {
    const { deps: d, fetchMock } = deps({ allowSubmission: () => false })
    const state = await handleContactSubmission(form(VALID), d)
    expect(state.status === 'error' && state.message).toMatch(/several messages/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends one plain-text email to the configured inbox with the sender as reply-to', async () => {
    const { deps: d, fetchMock } = deps()
    expect(await handleContactSubmission(form({ ...VALID, extra: 'ignored' }), d)).toEqual({
      status: 'success',
      message: CONTACT_SUCCESS_MESSAGE,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(RESEND_EMAILS_URL)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`)
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ from: CONFIG.from, to: ['inbox@example.com'], reply_to: 'sam@example.com' })
    expect(body.html).toBeUndefined()
    expect(body.text).toContain(SECRET_MESSAGE)
    expect(body.subject).toBe('Website contact: Early access (Sam Lee)')
  })

  it.each([
    ['a provider error', async () => new Response('{"message":"invalid"}', { status: 422 })],
    [
      'a network failure',
      async () => {
        throw new TypeError(`fetch failed for ${SECRET_MESSAGE}`)
      },
    ],
  ])('reports %s without logging the message or the key', async (_label, failure) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps: d } = deps({ fetch: vi.fn(failure) as unknown as typeof fetch })
    const state = await handleContactSubmission(form(VALID), d)
    expect(state.status === 'error' && state.message).toMatch(/couldn’t send/)
    const logged = JSON.stringify(log.mock.calls)
    expect(log).toHaveBeenCalled()
    expect(logged).not.toContain(SECRET_MESSAGE)
    expect(logged).not.toContain(API_KEY)
    expect(logged).not.toContain('sam@example.com')
  })

  it('builds the email without any HTML part', () => {
    const email = buildContactEmail(contactMessageSchema.parse({ ...VALID, message: '<img src=x onerror=alert(1)> hello' }), CONFIG)
    expect(Object.keys(email).sort()).toEqual(['from', 'reply_to', 'subject', 'text', 'to'])
  })
})

describe('rate limiter', () => {
  it('allows up to the limit per window, then resets', () => {
    const allow = createRateLimiter({ limit: 2, windowMs: 1000 })
    expect([allow('a', 0), allow('a', 10), allow('a', 20), allow('b', 20)]).toEqual([true, true, false, true])
    expect(allow('a', 1000)).toBe(true)
  })

  it('stays bounded: refuses new senders while full of active ones, and frees expired entries', () => {
    const allow = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 2 })
    expect([allow('a', 0), allow('b', 0), allow('c', 0)]).toEqual([true, true, false])
    expect(allow('c', 1000)).toBe(true)
  })
})

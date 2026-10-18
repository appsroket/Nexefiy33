// The only way connector code reaches a provider. Adds a time limit to every
// request, counts it against the shared rate-limit windows first, parses the
// body, and turns network failures into normalized errors that record whether
// the request may have reached the provider. It never logs requests: they
// carry tokens and customer data.

import 'server-only'

import { IntegrationError } from '../domain/errors'
import type { HttpClient, HttpRequest, HttpResponse } from '../connectors/types'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Called before each request with its buckets; throws IntegrationError('rate_limited') to refuse. */
export type RateLimitGate = (buckets: string[]) => Promise<void>

export interface HttpClientOptions {
  fetch: FetchLike
  timeoutMs: number
  defaultBuckets: string[]
  rateLimit?: RateLimitGate
  /** Aborts every request (e.g. the action's overall deadline). */
  signal?: AbortSignal
}

const USER_AGENT = 'Nexefiy-Integrations/1.0'

// Errors where the connection failed before the request could be sent.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

function networkErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  return typeof cause?.code === 'string' ? cause.code : undefined
}

function encodeForm(form: Record<string, string>): string {
  return new URLSearchParams(form).toString()
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      await options.rateLimit?.(request.rateLimitBuckets ?? options.defaultBuckets)

      const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT, ...request.headers }
      let body: string | undefined
      if (request.json !== undefined) {
        headers['Content-Type'] = 'application/json; charset=utf-8'
        body = JSON.stringify(request.json)
      } else if (request.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        body = encodeForm(request.form)
      }

      const timeout = AbortSignal.timeout(options.timeoutMs)
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout

      let response: Response
      try {
        response = await options.fetch(request.url, { method: request.method, headers, body, signal, redirect: 'error', cache: 'no-store' })
      } catch (error) {
        if (signal.aborted) {
          throw new IntegrationError('timeout', { mayHaveReachedProvider: true })
        }
        const code = networkErrorCode(error)
        const notSent = code !== undefined && NOT_SENT_CODES.has(code)
        throw new IntegrationError('unavailable', {
          message: notSent ? 'Couldn’t reach the provider.' : 'The connection to the provider failed.',
          providerCode: code,
          mayHaveReachedProvider: !notSent,
        })
      }

      let text: string
      try {
        text = await response.text()
      } catch {
        // Headers arrived, so the provider received the request.
        throw new IntegrationError(signal.aborted ? 'timeout' : 'unavailable', { mayHaveReachedProvider: true, httpStatus: response.status })
      }
      let parsed: unknown = text
      if (text && (response.headers.get('content-type') ?? '').includes('json')) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      return { status: response.status, headers: response.headers, body: parsed }
    },
  }
}

/** Resolves after `ms`, or rejects early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new IntegrationError('timeout', { mayHaveReachedProvider: false }))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new IntegrationError('timeout', { mayHaveReachedProvider: false }))
      },
      { once: true },
    )
  })
}

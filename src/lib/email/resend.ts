// Sends one plain-text email through the Resend REST API. Plain text only, so
// user-supplied content (names, messages) can never inject HTML.
//
// Never log the message or the API key; callers log only the result below.

import 'server-only'

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails'

export interface PlainTextEmail {
  from: string
  to: string[]
  subject: string
  text: string
  reply_to?: string
}

export type SendEmailResult =
  | { ok: true }
  | { ok: false; reason: 'rejected'; status: number }
  | { ok: false; reason: 'unreachable'; errorName: string }

export async function sendPlainTextEmail(
  apiKey: string,
  email: PlainTextEmail,
  fetchImpl: typeof fetch = fetch,
): Promise<SendEmailResult> {
  try {
    const response = await fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(10_000),
    })
    return response.ok ? { ok: true } : { ok: false, reason: 'rejected', status: response.status }
  } catch (error) {
    return { ok: false, reason: 'unreachable', errorName: error instanceof Error ? error.name : 'unknown' }
  }
}

/** Removes line breaks and other control characters from a header value such as a subject. */
export function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

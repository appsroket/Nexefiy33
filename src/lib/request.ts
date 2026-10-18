// Request details for Server Actions and Route Handlers.

import 'server-only'

import { headers } from 'next/headers'

/**
 * The caller's IP address, used only as a rate-limit key: never log or store
 * it. On Vercel the first x-forwarded-for entry is the client.
 */
export async function clientAddress(): Promise<string> {
  const requestHeaders = await headers()
  return requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || requestHeaders.get('x-real-ip') || 'unknown'
}

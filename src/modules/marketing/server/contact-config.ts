import 'server-only'

import { getServerEnv } from '@/lib/env/server'

import type { ContactDeliveryConfig } from './contact-service'

/** Delivery settings, or null while the email or contactForm feature isn't configured. */
export function getContactDeliveryConfig(): ContactDeliveryConfig | null {
  const env = getServerEnv()
  if (!env.email || !env.contactForm) return null
  return { resendApiKey: env.email.resendApiKey, from: env.email.from, to: env.contactForm.to }
}

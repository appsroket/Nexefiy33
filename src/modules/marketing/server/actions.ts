'use server'

import type { ActionState } from '@/lib/forms/action-state'
import { createRateLimiter } from '@/lib/rate-limit'
import { clientAddress } from '@/lib/request'

import { getContactDeliveryConfig } from './contact-config'
import { handleContactSubmission } from './contact-service'

const contactRateLimit = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 })

/** Public contact form. Validates on the server and delivers by email. */
export async function sendContactMessage(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const sender = await clientAddress()

  return handleContactSubmission(formData, {
    config: getContactDeliveryConfig(),
    allowSubmission: () => contactRateLimit(sender),
    fetch,
  })
}

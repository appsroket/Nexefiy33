// Server-side validation for the contact form.

import { z } from 'zod'

import { CONTACT_LIMITS, TOPIC_VALUES } from './contact'

// Removes control characters (including line breaks) from single-line fields,
// so they can't break the email subject or headers.
const singleLine = (max: number, label: string) =>
  z
    .string()
    .transform((value) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .pipe(z.string().max(max, `${label} must be ${max} characters or fewer.`))

export const contactMessageSchema = z.object({
  name: singleLine(CONTACT_LIMITS.name, 'Name').pipe(z.string().min(1, 'Enter your name.')),
  email: z
    .string()
    .trim()
    .pipe(z.email('Enter a valid email address, like name@example.com.').max(254, 'That email address is too long.')),
  company: singleLine(CONTACT_LIMITS.company, 'Company').optional().default(''),
  topic: z.enum(TOPIC_VALUES, 'Choose a topic.'),
  message: z
    .string()
    .trim()
    .min(CONTACT_LIMITS.messageMin, `Write at least ${CONTACT_LIMITS.messageMin} characters.`)
    .max(CONTACT_LIMITS.message, `Keep your message under ${CONTACT_LIMITS.message} characters.`),
})

export type ContactMessage = z.infer<typeof contactMessageSchema>

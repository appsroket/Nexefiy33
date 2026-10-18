// Contact form topics and limits, shared by the form and the server. Kept free
// of Zod so the browser bundle stays small; validation is in contact-schema.ts.

export const CONTACT_TOPICS = [
  { value: 'early-access', label: 'Early access' },
  { value: 'product', label: 'A question about the product' },
  { value: 'security', label: 'Security' },
  { value: 'other', label: 'Something else' },
] as const

export type ContactTopic = (typeof CONTACT_TOPICS)[number]['value']

export const TOPIC_VALUES = CONTACT_TOPICS.map((topic) => topic.value) as [ContactTopic, ...ContactTopic[]]

export const CONTACT_LIMITS = { name: 100, company: 120, message: 5000, messageMin: 10 } as const

/** Field name of the hidden honeypot input; people never see or fill it. */
export const HONEYPOT_FIELD = 'website'

export function topicLabel(topic: ContactTopic): string {
  return CONTACT_TOPICS.find((candidate) => candidate.value === topic)!.label
}

/** A `?topic=` query value, if it names a known topic. */
export function parseTopicParam(value: string | string[] | undefined): ContactTopic | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return TOPIC_VALUES.find((topic) => topic === raw)
}

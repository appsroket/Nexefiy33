// The kinds of business context an organization configures for its AI
// employees, as plain data shared by the forms, the server actions and the
// indexing pipeline. Mirrors business_context_items (kind check constraint,
// per-kind attribute schemas and the role each kind needs) — a test keeps them
// in sync with the migration. Free of Zod because client components import it.

import { hasMinRole, type OrganizationRole } from '@/lib/supabase/types'

export const CONTEXT_KINDS = [
  'product',
  'customer_segment',
  'goal',
  'department',
  'sop',
  'escalation_contact',
  'template',
  'faq',
] as const

export type ContextKind = (typeof CONTEXT_KINDS)[number]

export type AttributeField =
  | { key: string; label: string; type: 'text' | 'email' | 'tel' | 'url' | 'date'; maxLength: number; required?: boolean; placeholder?: string; description?: string }
  | { key: string; label: string; type: 'select'; options: readonly { value: string; label: string }[]; required?: boolean }
  | { key: string; label: string; type: 'integer'; min: number; max: number; required?: boolean; description?: string }

export interface ContextKindDefinition {
  kind: ContextKind
  /** URL segment under /app/knowledge. */
  slug: string
  label: string
  plural: string
  description: string
  titleLabel: string
  titleMaxLength: number
  bodyLabel: string
  bodyDescription?: string
  bodyRequired: boolean
  bodyMaxLength: number
  /** Lowest role that may create, edit or delete entries of this kind (enforced by RLS). */
  managedBy: Extract<OrganizationRole, 'operator' | 'admin'>
  /** Indexed for knowledge search. Escalation contacts are given to employees as structured data instead. */
  indexed: boolean
  attributes: readonly AttributeField[]
  /** Attribute sets of which at least one key must be filled (e.g. email or phone). */
  requireOneOf?: readonly string[]
  emptyHint: string
}

const BODY_MAX = 20000

export const CONTEXT_KIND_DEFINITIONS: Record<ContextKind, ContextKindDefinition> = {
  product: {
    kind: 'product',
    slug: 'products',
    label: 'Product or service',
    plural: 'Products and services',
    description: 'What you sell, so employees describe it accurately.',
    titleLabel: 'Name',
    titleMaxLength: 300,
    bodyLabel: 'Description',
    bodyDescription: 'What it is, who it is for, what is included and any limits.',
    bodyRequired: false,
    bodyMaxLength: BODY_MAX,
    managedBy: 'operator',
    indexed: true,
    attributes: [
      {
        key: 'offeringType',
        label: 'Type',
        type: 'select',
        options: [
          { value: 'product', label: 'Product' },
          { value: 'service', label: 'Service' },
        ],
      },
      { key: 'priceNote', label: 'Price note', type: 'text', maxLength: 200, placeholder: 'From 49 EUR per month' },
      { key: 'url', label: 'Web page', type: 'url', maxLength: 500, placeholder: 'https://example.com/product' },
    ],
    emptyHint: 'Add the products and services your employees should know about.',
  },
  customer_segment: {
    kind: 'customer_segment',
    slug: 'customers',
    label: 'Target customer',
    plural: 'Target customers',
    description: 'Who you serve and what they care about.',
    titleLabel: 'Segment',
    titleMaxLength: 300,
    bodyLabel: 'Description',
    bodyDescription: 'Who they are, their needs and pain points, and how to recognise a good fit.',
    bodyRequired: false,
    bodyMaxLength: BODY_MAX,
    managedBy: 'operator',
    indexed: true,
    attributes: [
      {
        key: 'priority',
        label: 'Priority',
        type: 'select',
        options: [
          { value: 'primary', label: 'Primary' },
          { value: 'secondary', label: 'Secondary' },
        ],
      },
    ],
    emptyHint: 'Describe the customers you want to win and serve.',
  },
  goal: {
    kind: 'goal',
    slug: 'goals',
    label: 'Goal',
    plural: 'Goals and KPIs',
    description: 'What the business is working towards and how you measure it.',
    titleLabel: 'Goal',
    titleMaxLength: 300,
    bodyLabel: 'Details',
    bodyRequired: false,
    bodyMaxLength: BODY_MAX,
    managedBy: 'operator',
    indexed: true,
    attributes: [
      { key: 'metric', label: 'KPI', type: 'text', maxLength: 200, placeholder: 'First reply time' },
      { key: 'target', label: 'Target', type: 'text', maxLength: 100, placeholder: 'Under 1 hour' },
      {
        key: 'period',
        label: 'Measured',
        type: 'select',
        options: [
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'quarterly', label: 'Quarterly' },
          { value: 'yearly', label: 'Yearly' },
        ],
      },
      { key: 'dueDate', label: 'Due date', type: 'date', maxLength: 10 },
    ],
    emptyHint: 'Add the goals and KPIs your employees should work towards.',
  },
  department: {
    kind: 'department',
    slug: 'departments',
    label: 'Department',
    plural: 'Departments',
    description: 'How your company is organised and who handles what.',
    titleLabel: 'Name',
    titleMaxLength: 300,
    bodyLabel: 'Responsibilities',
    bodyRequired: false,
    bodyMaxLength: BODY_MAX,
    managedBy: 'operator',
    indexed: true,
    attributes: [
      { key: 'lead', label: 'Lead', type: 'text', maxLength: 200 },
      { key: 'email', label: 'Team email', type: 'email', maxLength: 254 },
    ],
    emptyHint: 'Add your departments so employees know who does what.',
  },
  sop: {
    kind: 'sop',
    slug: 'procedures',
    label: 'Procedure',
    plural: 'Standard operating procedures',
    description: 'Step-by-step instructions for recurring work.',
    titleLabel: 'Name',
    titleMaxLength: 300,
    bodyLabel: 'Steps',
    bodyDescription: 'Write one step per line. Employees follow these as reference, never as permission to act.',
    bodyRequired: true,
    bodyMaxLength: BODY_MAX,
    managedBy: 'operator',
    indexed: true,
    attributes: [
      { key: 'trigger', label: 'When it applies', type: 'text', maxLength: 500, placeholder: 'A customer asks for a refund' },
      { key: 'department', label: 'Department', type: 'text', maxLength: 200 },
    ],
    emptyHint: 'Write down how recurring work should be done.',
  },
  escalation_contact: {
    kind: 'escalation_contact',
    slug: 'contacts',
    label: 'Escalation contact',
    plural: 'Escalation contacts',
    description: 'The people employees hand work to when they cannot or should not handle it.',
    titleLabel: 'Name',
    titleMaxLength: 300,
    bodyLabel: 'Escalate when',
    bodyDescription: 'The situations this person should be contacted for.',
    bodyRequired: false,
    bodyMaxLength: 2000,
    managedBy: 'admin',
    indexed: false,
    attributes: [
      { key: 'role', label: 'Role', type: 'text', maxLength: 200, placeholder: 'Finance lead' },
      { key: 'email', label: 'Email', type: 'email', maxLength: 254 },
      { key: 'phone', label: 'Phone', type: 'tel', maxLength: 40 },
      { key: 'availability', label: 'Availability', type: 'text', maxLength: 300, placeholder: 'Weekdays 9:00–17:00' },
      { key: 'priority', label: 'Order', type: 'integer', min: 1, max: 10, description: '1 is contacted first.' },
    ],
    requireOneOf: ['email', 'phone'],
    emptyHint: 'Add who employees should escalate to. Only admins and owners can change this list.',
  },
  template: {
    kind: 'template',
    slug: 'templates',
    label: 'Communication template',
    plural: 'Approved communication templates',
    description: 'Wording employees may use when they write to people outside the company.',
    titleLabel: 'Name',
    titleMaxLength: 300,
    bodyLabel: 'Message',
    bodyDescription: 'Use {{placeholders}} for details that change, such as {{customer_name}}.',
    bodyRequired: true,
    bodyMaxLength: BODY_MAX,
    managedBy: 'admin',
    indexed: true,
    attributes: [
      {
        key: 'channel',
        label: 'Channel',
        type: 'select',
        required: true,
        options: [
          { value: 'email', label: 'Email' },
          { value: 'sms', label: 'Text message' },
          { value: 'chat', label: 'Chat' },
          { value: 'voice', label: 'Voice' },
        ],
      },
      { key: 'subject', label: 'Subject', type: 'text', maxLength: 300 },
    ],
    emptyHint: 'Add approved wording. Only admins and owners can approve templates.',
  },
  faq: {
    kind: 'faq',
    slug: 'faqs',
    label: 'FAQ',
    plural: 'Frequently asked questions',
    description: 'Answers to the questions customers and staff ask most.',
    titleLabel: 'Question',
    titleMaxLength: 300,
    bodyLabel: 'Answer',
    bodyRequired: true,
    bodyMaxLength: BODY_MAX,
    managedBy: 'operator',
    indexed: true,
    attributes: [],
    emptyHint: 'Add the questions you are asked most, with the answers you give.',
  },
}

export function isContextKind(value: unknown): value is ContextKind {
  return typeof value === 'string' && (CONTEXT_KINDS as readonly string[]).includes(value)
}

export function contextKindBySlug(slug: string): ContextKindDefinition | undefined {
  return Object.values(CONTEXT_KIND_DEFINITIONS).find((definition) => definition.slug === slug)
}

/** Mirrors the business_context_items policies; the database still decides. */
export function canManageContextKind(role: OrganizationRole, kind: ContextKind): boolean {
  return hasMinRole(role, CONTEXT_KIND_DEFINITIONS[kind].managedBy)
}

export function canManageKnowledge(role: OrganizationRole): boolean {
  return hasMinRole(role, 'operator')
}

export function canEditCompanyProfile(role: OrganizationRole): boolean {
  return hasMinRole(role, 'admin')
}

export type ContextAttributes = Record<string, string | number>

export interface ContextItem {
  id: string
  kind: ContextKind
  title: string
  body: string
  attributes: ContextAttributes
  position: number
  status: 'active' | 'archived'
  updatedAt: string
}

/** Readable "Label: value" lines for an item's attributes, in definition order. */
export function describeAttributes(kind: ContextKind, attributes: ContextAttributes): string[] {
  const lines: string[] = []
  for (const field of CONTEXT_KIND_DEFINITIONS[kind].attributes) {
    const value = attributes[field.key]
    if (value === undefined || value === '') continue
    const shown = field.type === 'select' ? (field.options.find((option) => option.value === value)?.label ?? String(value)) : String(value)
    lines.push(`${field.label}: ${shown}`)
  }
  return lines
}

/**
 * The text indexed for search: a heading naming the kind, the title, the
 * attributes and the body. The heading makes passages self-describing when
 * they are cited ("FAQ: Do you ship abroad?").
 */
export function contextItemToText(item: Pick<ContextItem, 'kind' | 'title' | 'body' | 'attributes'>): string {
  const definition = CONTEXT_KIND_DEFINITIONS[item.kind]
  const parts = [`${definition.label}: ${item.title.trim()}`]
  const attributes = describeAttributes(item.kind, item.attributes)
  if (attributes.length) parts.push(attributes.join('\n'))
  if (item.body.trim()) parts.push(item.kind === 'faq' ? `Answer: ${item.body.trim()}` : item.body.trim())
  return parts.join('\n\n')
}

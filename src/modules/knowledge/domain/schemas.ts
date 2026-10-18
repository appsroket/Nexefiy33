// Zod schemas for knowledge forms and actions. Server-side only: client
// components import context-kinds.ts, company-profile.ts and files.ts instead,
// which stay free of Zod (a test enforces this).

import { z } from 'zod'

import { companyDetailsSchema } from '@/modules/identity/domain/schemas'

import {
  FORMALITY_LEVELS,
  TEAM_SIZES,
  timeRangeProblems,
  WEEKDAYS,
  type CompanySettingsJson,
  type WeeklyHours,
} from './company-profile'
import { CONTEXT_KIND_DEFINITIONS, CONTEXT_KINDS, type AttributeField, type ContextAttributes, type ContextKind } from './context-kinds'
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from './files'

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE = /^\+?[0-9 ().-]{5,40}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

// Context items -------------------------------------------------------------------

/** Form field name for an attribute, so attributes can't collide with title/body. */
export function attributeFieldName(key: string): string {
  return `attr_${key}`
}

function attributeSchema(field: AttributeField): z.ZodType<string | number | undefined> {
  const empty = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value)
  if (field.type === 'select') {
    const values = field.options.map((option) => option.value) as [string, ...string[]]
    const base = z.enum(values, { error: `Choose a ${field.label.toLowerCase()}.` })
    return z.preprocess(empty, field.required ? base : base.optional())
  }
  if (field.type === 'integer') {
    const base = z.coerce
      .number({ error: `Enter a whole number from ${field.min} to ${field.max}.` })
      .int(`Enter a whole number from ${field.min} to ${field.max}.`)
      .min(field.min, `Enter a whole number from ${field.min} to ${field.max}.`)
      .max(field.max, `Enter a whole number from ${field.min} to ${field.max}.`)
    return z.preprocess(empty, field.required ? base : base.optional())
  }
  let base = z.string().trim().max(field.maxLength, `Use at most ${field.maxLength} characters.`)
  if (field.type === 'email') base = base.regex(EMAIL, 'Enter a valid email address.')
  if (field.type === 'tel') base = base.regex(PHONE, 'Enter a phone number using digits, spaces and + ( ) - .')
  if (field.type === 'date') base = base.regex(DATE, 'Enter a date.')
  if (field.type === 'url') {
    return z.preprocess(
      (value) => {
        const text = empty(value)
        return typeof text === 'string' && !/^https?:\/\//i.test(text.trim()) ? `https://${text.trim()}` : text
      },
      field.required ? base.refine(URL.canParse, 'Enter a web address.') : base.refine(URL.canParse, 'Enter a web address.').optional(),
    )
  }
  return z.preprocess(empty, field.required ? base.min(1, `Enter ${field.label.toLowerCase()}.`) : base.optional())
}

export interface ParsedContextItem {
  kind: ContextKind
  title: string
  body: string
  attributes: ContextAttributes
}

/** The schema for one kind's form: title, body and that kind's attributes. */
export function contextItemSchema(kind: ContextKind): z.ZodType<ParsedContextItem> {
  const definition = CONTEXT_KIND_DEFINITIONS[kind]
  const shape: Record<string, z.ZodType> = {
    title: z
      .string({ error: `Enter ${definition.titleLabel.toLowerCase()}.` })
      .trim()
      .min(1, `Enter ${definition.titleLabel.toLowerCase()}.`)
      .max(definition.titleMaxLength, `Use at most ${definition.titleMaxLength} characters.`),
    body: definition.bodyRequired
      ? z
          .string({ error: `Enter ${definition.bodyLabel.toLowerCase()}.` })
          .trim()
          .min(1, `Enter ${definition.bodyLabel.toLowerCase()}.`)
          .max(definition.bodyMaxLength, `Use at most ${definition.bodyMaxLength} characters.`)
      : z.string().trim().max(definition.bodyMaxLength, `Use at most ${definition.bodyMaxLength} characters.`).optional().default(''),
  }
  for (const field of definition.attributes) shape[attributeFieldName(field.key)] = attributeSchema(field)

  return z
    .object(shape)
    .superRefine((value, context) => {
      const required = definition.requireOneOf
      if (required && !required.some((key) => value[attributeFieldName(key)] !== undefined)) {
        const labels = required.map((key) => definition.attributes.find((field) => field.key === key)?.label.toLowerCase() ?? key)
        for (const key of required) {
          context.addIssue({ code: 'custom', path: [attributeFieldName(key)], message: `Enter ${labels.join(' or ')}.` })
        }
      }
    })
    .transform((value) => {
      const attributes: ContextAttributes = {}
      for (const field of definition.attributes) {
        const entry = value[attributeFieldName(field.key)]
        if (entry !== undefined) attributes[field.key] = entry as string | number
      }
      return { kind, title: value.title as string, body: (value.body as string) ?? '', attributes }
    }) as unknown as z.ZodType<ParsedContextItem>
}

export const contextKindSchema = z.enum(CONTEXT_KINDS)

// Company profile -----------------------------------------------------------------

const listOf = (separator: RegExp, maxItems: number, maxLength: number, label: string) =>
  z
    .string()
    .optional()
    .transform((value) => [...new Set((value ?? '').split(separator).map((item) => item.trim()).filter(Boolean))])
    .pipe(
      z
        .array(z.string().max(maxLength, `Each ${label} can be at most ${maxLength} characters.`))
        .max(maxItems, `Add at most ${maxItems} ${label}s.`),
    )

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .optional()
    .transform((value) => value || undefined)

const hoursFields = Object.fromEntries(
  WEEKDAYS.flatMap((day) => [
    [`hours_${day}_open`, z.string().trim().optional()],
    [`hours_${day}_close`, z.string().trim().optional()],
    [`hours_${day}_closed`, z.string().optional()],
  ]),
) as Record<string, z.ZodOptional<z.ZodString>>

export const companyProfileSchema = companyDetailsSchema
  .extend({
    brandVoice: z
      .string()
      .trim()
      .max(2000, 'Use at most 2000 characters.')
      .optional()
      .transform((value) => value || null),
    headquarters: optionalText(200),
    foundedYear: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.coerce.number().int('Enter a year.').min(1800, 'Enter a year after 1800.').max(2100, 'Enter a year before 2100.').optional(),
    ),
    teamSize: z.preprocess((value) => (value === '' ? undefined : value), z.enum(TEAM_SIZES).optional()),
    serviceArea: optionalText(500),
    languages: listOf(/[,\n]/, 20, 60, 'language'),
    formality: z.preprocess((value) => (value === '' ? undefined : value), z.enum(FORMALITY_LEVELS).optional()),
    tone: listOf(/[,\n]/, 10, 40, 'tone word'),
    preferredPhrases: listOf(/\n/, 20, 200, 'phrase'),
    avoidPhrases: listOf(/\n/, 20, 200, 'phrase'),
    hoursEnabled: z.string().optional(),
    hoursNotes: optionalText(1000),
    ...hoursFields,
  })
  .superRefine((value, context) => {
    if (!value.hoursEnabled) return
    for (const day of WEEKDAYS) {
      const record = value as unknown as Record<string, string | undefined>
      if (record[`hours_${day}_closed`]) continue
      const open = record[`hours_${day}_open`] ?? ''
      const close = record[`hours_${day}_close`] ?? ''
      if (!open || !close) {
        context.addIssue({ code: 'custom', path: [`hours_${day}_open`], message: 'Enter opening and closing times, or mark the day closed.' })
        continue
      }
      for (const problem of timeRangeProblems([{ open, close }])) {
        context.addIssue({ code: 'custom', path: [`hours_${day}_open`], message: problem })
      }
    }
  })
  .transform((value) => {
    const record = value as unknown as Record<string, string | undefined>
    let operatingHours: CompanySettingsJson['operatingHours']
    if (value.hoursEnabled) {
      const weekly: WeeklyHours = {}
      for (const day of WEEKDAYS) {
        weekly[day] = record[`hours_${day}_closed`] ? [] : [{ open: record[`hours_${day}_open`]!, close: record[`hours_${day}_close`]! }]
      }
      operatingHours = { weekly, ...(value.hoursNotes ? { notes: value.hoursNotes } : {}) }
    }
    const profile = compact({
      headquarters: value.headquarters,
      foundedYear: value.foundedYear,
      teamSize: value.teamSize,
      serviceArea: value.serviceArea,
      languages: value.languages.length ? value.languages : undefined,
    })
    const brandVoice = compact({
      formality: value.formality,
      tone: value.tone.length ? value.tone : undefined,
      preferredPhrases: value.preferredPhrases.length ? value.preferredPhrases : undefined,
      avoidPhrases: value.avoidPhrases.length ? value.avoidPhrases : undefined,
    })
    const settings: CompanySettingsJson = {
      schemaVersion: 1,
      ...(profile ? { profile } : {}),
      ...(operatingHours ? { operatingHours } : {}),
      ...(brandVoice ? { brandVoice } : {}),
    }
    return {
      legalName: value.legalName,
      industry: value.industry,
      website: value.website,
      description: value.description,
      timezone: value.timezone,
      brandVoice: value.brandVoice,
      settings,
    }
  })

export type CompanyProfileInput = z.output<typeof companyProfileSchema>

function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
}

// Documents -----------------------------------------------------------------------

export const uploadRequestSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(255),
      size: z.number().int().positive().max(MAX_FILE_BYTES),
    }),
  )
  .min(1, 'Choose at least one file.')
  .max(MAX_FILES_PER_UPLOAD, `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.`)

export const registerUploadSchema = z.object({
  uploadId: z.uuid(),
  path: z.string().min(1).max(1024),
  name: z.string().trim().min(1).max(255),
})

// Search --------------------------------------------------------------------------

export const knowledgeQuerySchema = z
  .string({ error: 'Enter a question.' })
  .trim()
  .min(2, 'Enter a question.')
  .max(1000, 'Use at most 1000 characters.')

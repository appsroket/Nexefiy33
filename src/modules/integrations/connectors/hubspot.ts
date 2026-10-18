// HubSpot CRM connector: find contacts, create or update a contact by email,
// and add a note to a contact.
//
// Provider documentation checked 2026-10-18 (developers.hubspot.com):
// - OAuth: authorize at app.hubspot.com/oauth/authorize; token, introspect and
//   revoke at api.hubapi.com/oauth/2026-03/token[/introspect|/revoke], all
//   form-encoded with the client credentials in the body. Access tokens last
//   30 minutes; refresh tokens stay valid until the app is uninstalled or the
//   token is revoked.
// - CRM objects use date-based versions: /crm/objects/2026-09/{object}, search
//   at /crm/objects/2026-09/{object}/search. Notes need hs_timestamp and are
//   associated to contacts with HUBSPOT_DEFINED type 202.
// - Limits: 110 requests per 10 seconds per installing account for OAuth apps
//   (search excluded); search is limited to 5 requests per second per token.
//   429 responses carry policyName and may carry Retry-After.
// - Errors: { status, message, correlationId, category, errors[] }; OAuth
//   2026-03 errors add RFC 6749 error / error_description.
// Not yet verified against a live HubSpot account (docs/known-limitations.md);
// the revoke request body and the introspect response fields are the least
// certain parts.

import { z } from 'zod'

import { IntegrationError, parseRetryAfter, type IntegrationErrorCode } from '../domain/errors'
import { expiresAtFrom, isRecord, optionalText, READ_RETRY, splitScopes, stringField, text, truncate, WRITE_RETRY } from './shared'
import {
  defineAction,
  type ActionContext,
  type ConnectorDefinition,
  type HttpClient,
  type HttpResponse,
  type OAuthClient,
  type TokenSet,
} from './types'

const API = 'https://api.hubapi.com'
export const HUBSPOT_OAUTH_VERSION = '2026-03'
export const HUBSPOT_CRM_VERSION = '2026-09'
const OAUTH = `${API}/oauth/${HUBSPOT_OAUTH_VERSION}`
const CRM = `${API}/crm/objects/${HUBSPOT_CRM_VERSION}`

const CONTACTS_READ = 'crm.objects.contacts.read'
const CONTACTS_WRITE = 'crm.objects.contacts.write'
const NOTE_TO_CONTACT = 202

const SEARCH_BUCKET = 'hubspot.search'
const DEFAULT_BUCKET = 'hubspot.default'

const CONTACT_PROPERTIES = ['email', 'firstname', 'lastname', 'company', 'phone', 'jobtitle', 'lifecyclestage', 'lastmodifieddate']

// --- Errors ------------------------------------------------------------------

function errorFields(body: unknown) {
  return {
    message: stringField(body, 'message') ?? stringField(body, 'error_description'),
    category: stringField(body, 'category'),
    oauthError: stringField(body, 'error'),
    correlationId: stringField(body, 'correlationId'),
    policyName: stringField(body, 'policyName'),
  }
}

export function normalizeHubSpotError(response: HttpResponse): IntegrationError {
  const { message, category, oauthError, correlationId, policyName } = errorFields(response.body)
  const base = { httpStatus: response.status, correlationId, providerCode: category ?? oauthError }
  const status = response.status

  if (status === 429) {
    const fallback = policyName === 'DAILY' ? undefined : policyName === 'TEN_SECONDLY_ROLLING' ? 10_000 : 1_000
    return new IntegrationError('rate_limited', {
      ...base,
      providerCode: policyName ?? category,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) ?? fallback,
      retryable: policyName !== 'DAILY',
      message: policyName === 'DAILY' ? 'HubSpot’s daily API limit for this account was reached.' : undefined,
    })
  }
  if (oauthError === 'invalid_grant') return new IntegrationError('reauth_required', { ...base, message })
  if (oauthError === 'invalid_client') {
    return new IntegrationError('not_configured', { ...base, message: 'HubSpot rejected this deployment’s app credentials.' })
  }

  let code: IntegrationErrorCode
  if (status === 401) code = 'reauth_required'
  else if (status === 403) code = category === 'MISSING_SCOPES' ? 'insufficient_scope' : 'forbidden'
  else if (status === 404) code = 'not_found'
  else if (status === 409) code = 'conflict'
  else if (status === 400 || status === 422) code = 'invalid_input'
  else if (status >= 500) code = 'unavailable'
  else code = 'provider_error'
  return new IntegrationError(code, { ...base, message })
}

async function call(http: HttpClient, request: Parameters<HttpClient['send']>[0]): Promise<Record<string, unknown>> {
  const response = await http.send(request)
  if (response.status < 200 || response.status >= 300) throw normalizeHubSpotError(response)
  if (response.status === 204) return {}
  if (!isRecord(response.body)) throw new IntegrationError('provider_error', { message: 'HubSpot returned an unexpected response.', httpStatus: response.status })
  return response.body
}

function bearer(context: ActionContext) {
  return { Authorization: `Bearer ${context.accessToken}` }
}

// --- OAuth -------------------------------------------------------------------

function tokensFrom(body: Record<string, unknown>, fallbackRefresh?: string): TokenSet {
  const accessToken = stringField(body, 'access_token')
  if (!accessToken) throw new IntegrationError('provider_error', { message: 'HubSpot did not return an access token.' })
  const refreshToken = stringField(body, 'refresh_token') ?? fallbackRefresh
  const expiresAt = expiresAtFrom(body.expires_in)
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    scopes: splitScopes(body.scopes ?? body.scope),
  }
}

function hubIdOf(body: Record<string, unknown>): string | undefined {
  const value = body.hub_id ?? body.hubId
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return undefined
}

async function exchangeCode(http: HttpClient, client: OAuthClient, params: { code: string; redirectUri: string }) {
  const body = await call(http, {
    method: 'POST',
    url: `${OAUTH}/token`,
    form: {
      grant_type: 'authorization_code',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: params.redirectUri,
      code: params.code,
    },
  })
  const tokens = tokensFrom(body)

  // Account details: the token response may include hub_id; introspection is authoritative.
  const info = await call(http, {
    method: 'POST',
    url: `${OAUTH}/token/introspect`,
    form: {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      token: tokens.accessToken,
      token_type_hint: 'access_token',
    },
  })
  const hubId = hubIdOf(info) ?? hubIdOf(body)
  if (!hubId) throw new IntegrationError('provider_error', { message: 'HubSpot did not say which account was connected.' })
  const hubDomain = stringField(info, 'hub_domain') ?? null
  const scopes = splitScopes(info.scopes ?? info.scope)
  return {
    tokens: { ...tokens, scopes: scopes.length ? scopes : tokens.scopes },
    account: {
      externalAccountId: hubId,
      label: hubDomain ?? `HubSpot account ${hubId}`,
      metadata: { hubId, hubDomain },
      ...(scopes.length ? { scopes } : {}),
    },
  }
}

async function refresh(http: HttpClient, client: OAuthClient, refreshToken: string): Promise<TokenSet> {
  const body = await call(http, {
    method: 'POST',
    url: `${OAUTH}/token`,
    form: { grant_type: 'refresh_token', client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken },
  })
  return tokensFrom(body, refreshToken)
}

async function revoke(http: HttpClient, client: OAuthClient, tokens: TokenSet): Promise<void> {
  if (!tokens.refreshToken) throw new IntegrationError('provider_error', { message: 'No refresh token to revoke.' })
  await call(http, {
    method: 'POST',
    url: `${OAUTH}/token/revoke`,
    form: { token: tokens.refreshToken, token_type_hint: 'refresh_token', client_id: client.clientId, client_secret: client.clientSecret },
  })
}

// --- Contacts ------------------------------------------------------------------

const contactSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  company: z.string().nullable(),
  phone: z.string().nullable(),
  jobTitle: z.string().nullable(),
  lifecycleStage: z.string().nullable(),
  updatedAt: z.string().nullable(),
  url: z.string().nullable(),
})
type Contact = z.infer<typeof contactSchema>

function recordUrl(context: ActionContext, objectTypeId: string, id: string): string | null {
  const hubId = context.connection.metadata.hubId
  return typeof hubId === 'string' && /^\d+$/.test(hubId) ? `https://app.hubspot.com/contacts/${hubId}/record/${objectTypeId}/${id}` : null
}

function toContact(context: ActionContext, record: unknown): Contact {
  const id = stringField(record, 'id')
  if (!id) throw new IntegrationError('provider_error', { message: 'HubSpot returned a contact without an id.' })
  const properties = isRecord(record) && isRecord(record.properties) ? record.properties : {}
  const prop = (key: string) => (typeof properties[key] === 'string' && properties[key] ? (properties[key] as string) : null)
  return {
    id,
    email: prop('email'),
    firstName: prop('firstname'),
    lastName: prop('lastname'),
    company: prop('company'),
    phone: prop('phone'),
    jobTitle: prop('jobtitle'),
    lifecycleStage: prop('lifecyclestage'),
    updatedAt: prop('lastmodifieddate') ?? stringField(record, 'updatedAt') ?? null,
    url: recordUrl(context, '0-1', id),
  }
}

async function searchContacts(context: ActionContext, body: Record<string, unknown>) {
  const result = await call(context.http, {
    method: 'POST',
    url: `${CRM}/contacts/search`,
    headers: bearer(context),
    json: { ...body, properties: CONTACT_PROPERTIES },
    rateLimitBuckets: [SEARCH_BUCKET],
  })
  const results = Array.isArray(result.results) ? result.results : []
  const total = typeof result.total === 'number' ? result.total : results.length
  return { total, contacts: results.map((record) => toContact(context, record)) }
}

function byEmail(email: string) {
  return { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] }
}

const email = z.string().trim().toLowerCase().pipe(z.email().max(254))

const searchInput = z
  .object({
    email: email.optional(),
    query: optionalText(200),
    limit: z.coerce.number().int().min(1).max(20).default(5),
  })
  .refine((value) => Boolean(value.email || value.query), { message: 'Give an email address or search text.', path: ['query'] })

const searchOutput = z.object({ total: z.number().int().min(0), contacts: z.array(contactSchema) })

const searchContactsAction = defineAction({
  key: 'hubspot.contacts.search',
  title: 'Find contacts',
  description: 'Searches HubSpot contacts by exact email address or by text (name, email, phone, company).',
  input: searchInput,
  output: searchOutput,
  scopes: [CONTACTS_READ],
  risk: 'read',
  approval: 'none',
  idempotency: { kind: 'read_only' },
  timeoutMs: 15_000,
  retry: READ_RETRY,
  rateLimitBucket: SEARCH_BUCKET,
  exampleInput: { email: 'dana@example.com' },
  summarize: (input) => (input.email ? `Find the HubSpot contact with email ${input.email}` : `Search HubSpot contacts for “${truncate(input.query ?? '', 80)}”`),
  redactOutput: (output) => ({ total: output.total, contactIds: output.contacts.map((contact) => contact.id) }),
  async execute(context, input) {
    const result = await searchContacts(context, { ...(input.email ? byEmail(input.email) : { query: input.query }), limit: input.limit })
    return { total: result.total, contacts: result.contacts.slice(0, input.limit) }
  },
})

const LIFECYCLE_STAGES = ['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist', 'other'] as const

const upsertInput = z.object({
  email,
  firstName: optionalText(100),
  lastName: optionalText(100),
  company: optionalText(200),
  phone: optionalText(50),
  jobTitle: optionalText(100),
  lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
})
type UpsertInput = z.infer<typeof upsertInput>

const upsertOutput = z.object({ id: z.string(), result: z.enum(['created', 'updated']), email: z.string(), url: z.string().nullable() })

function contactProperties(input: UpsertInput): Record<string, string> {
  const properties: Record<string, string> = { email: input.email }
  if (input.firstName) properties.firstname = input.firstName
  if (input.lastName) properties.lastname = input.lastName
  if (input.company) properties.company = input.company
  if (input.phone) properties.phone = input.phone
  if (input.jobTitle) properties.jobtitle = input.jobTitle
  if (input.lifecycleStage) properties.lifecyclestage = input.lifecycleStage
  return properties
}

/** "Contact already exists. Existing ID: 123" (HubSpot 409 message). */
export function existingIdFromConflict(error: IntegrationError): string | undefined {
  return /Existing ID:\s*(\d+)/i.exec(error.message)?.[1]
}

async function updateContact(context: ActionContext, id: string, properties: Record<string, string>) {
  const { email: _email, ...changes } = properties
  if (Object.keys(changes).length === 0) return
  await call(context.http, { method: 'PATCH', url: `${CRM}/contacts/${encodeURIComponent(id)}`, headers: bearer(context), json: { properties: changes } })
}

const upsertContactAction = defineAction({
  key: 'hubspot.contacts.upsert',
  title: 'Create or update a contact',
  description:
    'Creates a HubSpot contact, or updates the existing contact with the same email address. Only the fields given are changed.',
  input: upsertInput,
  output: upsertOutput,
  scopes: [CONTACTS_READ, CONTACTS_WRITE],
  risk: 'write_external',
  approval: 'default_required',
  idempotency: {
    kind: 'natural_key',
    key: 'email',
    description: 'HubSpot keeps one contact per email address, so repeating the action updates the same contact instead of creating another.',
  },
  timeoutMs: 20_000,
  retry: WRITE_RETRY,
  rateLimitBucket: DEFAULT_BUCKET,
  exampleInput: { email: 'dana@example.com', firstName: 'Dana', lastName: 'Lee', company: 'Example Co', lifecycleStage: 'lead' },
  summarize: (input) => `Create or update the HubSpot contact ${input.email}`,
  async execute(context, input) {
    const properties = contactProperties(input)
    const existing = await searchContacts(context, { ...byEmail(input.email), limit: 1 })
    const match = existing.contacts[0]
    if (match) {
      await updateContact(context, match.id, properties)
      return { id: match.id, result: 'updated' as const, email: input.email, url: match.url }
    }
    try {
      const created = await call(context.http, { method: 'POST', url: `${CRM}/contacts`, headers: bearer(context), json: { properties } })
      const id = stringField(created, 'id')
      if (!id) throw new IntegrationError('provider_error', { message: 'HubSpot created the contact but returned no id.' })
      return { id, result: 'created' as const, email: input.email, url: recordUrl(context, '0-1', id) }
    } catch (error) {
      // Search results lag behind writes; HubSpot names the contact that already has this email.
      const existingId = error instanceof IntegrationError && error.code === 'conflict' ? existingIdFromConflict(error) : undefined
      if (!existingId) throw error
      await updateContact(context, existingId, properties)
      return { id: existingId, result: 'updated' as const, email: input.email, url: recordUrl(context, '0-1', existingId) }
    }
  },
})

// --- Notes ---------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>')
}

const noteInput = z.object({
  contactId: z.string().trim().regex(/^\d{1,20}$/, 'Use the numeric HubSpot contact id.'),
  body: text(1, 5000),
})

const noteOutput = z.object({ id: z.string(), contactId: z.string(), url: z.string().nullable() })

const createNoteAction = defineAction({
  key: 'hubspot.notes.create',
  title: 'Add a note to a contact',
  description: 'Adds a note to a HubSpot contact’s timeline. The text is stored as plain text.',
  input: noteInput,
  output: noteOutput,
  scopes: [CONTACTS_WRITE],
  risk: 'write_external',
  approval: 'default_required',
  idempotency: {
    kind: 'not_idempotent',
    description: 'HubSpot has no way to recognise a repeated note, so a note is never sent again once it may have arrived.',
  },
  timeoutMs: 15_000,
  retry: WRITE_RETRY,
  rateLimitBucket: DEFAULT_BUCKET,
  exampleInput: { contactId: '12345', body: 'Asked for a quote for 20 seats. Follow up on Friday.' },
  summarize: (input) => `Add a note to HubSpot contact ${input.contactId}: “${truncate(input.body, 80)}”`,
  redactInput: (input) => ({ contactId: input.contactId, bodyPreview: truncate(input.body, 120), bodyLength: input.body.length }),
  async execute(context, input) {
    const created = await call(context.http, {
      method: 'POST',
      url: `${CRM}/notes`,
      headers: bearer(context),
      json: {
        properties: { hs_note_body: escapeHtml(input.body), hs_timestamp: new Date().toISOString() },
        associations: [{ to: { id: input.contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
      },
    })
    const id = stringField(created, 'id')
    if (!id) throw new IntegrationError('provider_error', { message: 'HubSpot created the note but returned no id.' })
    return { id, contactId: input.contactId, url: recordUrl(context, '0-1', input.contactId) }
  },
})

// --- Connector -------------------------------------------------------------------

export const hubspotConnector: ConnectorDefinition = {
  provider: 'hubspot',
  displayName: 'HubSpot',
  category: 'crm',
  description: 'Find contacts, keep contact details current, and log notes on the contact timeline.',
  docsUrl: 'https://developers.hubspot.com/docs/api-reference/latest/overview',
  feature: 'hubspotIntegration',
  auth: {
    kind: 'oauth2',
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    scopeSeparator: ' ',
    baseScopes: ['oauth'],
    tokenRefresh: 'refresh_token',
    revocation: 'Revokes the refresh token at HubSpot, which ends the app’s access to the account.',
    exchangeCode,
    refresh,
    revoke,
  },
  rateLimits: {
    [DEFAULT_BUCKET]: { bucket: DEFAULT_BUCKET, limit: 100, windowSeconds: 10, source: 'HubSpot: 110 requests / 10 s per account for OAuth apps (kept at 100)' },
    [SEARCH_BUCKET]: { bucket: SEARCH_BUCKET, limit: 4, windowSeconds: 1, source: 'HubSpot: CRM search 5 requests / s per token (kept at 4)' },
  },
  defaultRateLimitBucket: DEFAULT_BUCKET,
  requestTimeoutMs: 10_000,
  async healthCheck(context) {
    await call(context.http, { method: 'GET', url: `${CRM}/contacts?limit=1&archived=false`, headers: bearer(context) })
    return { status: 'healthy', message: 'HubSpot accepted the connection and returned contact data.' }
  },
  normalizeError: normalizeHubSpotError,
  actions: [searchContactsAction, upsertContactAction, createNoteAction],
}

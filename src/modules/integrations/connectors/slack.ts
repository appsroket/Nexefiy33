// Slack connector: list public channels and post a message as the app's bot.
//
// Provider documentation checked 2026-10-18 (docs.slack.dev):
// - OAuth v2: authorize at slack.com/oauth/v2/authorize with comma-separated
//   bot scopes; exchange with oauth.v2.access, client credentials preferably
//   sent with HTTP Basic auth. The bot token is at the top level of the
//   response, the workspace in `team`. Tokens don't expire unless token
//   rotation is enabled (then 12 hours, renewed with grant_type=refresh_token,
//   and each refresh returns a new refresh token).
// - auth.revoke revokes the token ({ ok, revoked }); auth.test checks it.
// - chat.postMessage (chat:write): about 1 message per second per channel;
//   conversations.list (channels:read): Tier 2, 20+ per minute.
// - Errors: HTTP 200 with { ok: false, error }; HTTP 429 with Retry-After.
// Not yet verified against a live Slack workspace (docs/known-limitations.md).

import { z } from 'zod'

import { IntegrationError, parseRetryAfter, type IntegrationErrorCode } from '../domain/errors'
import { expiresAtFrom, isRecord, READ_RETRY, splitScopes, stringField, text, truncate, WRITE_RETRY } from './shared'
import {
  defineAction,
  type ActionContext,
  type ConnectorDefinition,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type OAuthClient,
  type TokenSet,
} from './types'

const API = 'https://slack.com/api'

const DEFAULT_BUCKET = 'slack.default'
const TIER2_BUCKET = 'slack.tier2'
const POST_BUCKET = 'slack.post'

// --- Errors ------------------------------------------------------------------

const ERROR_CODES: Record<string, IntegrationErrorCode> = {
  not_authed: 'reauth_required',
  invalid_auth: 'reauth_required',
  account_inactive: 'reauth_required',
  token_revoked: 'reauth_required',
  token_expired: 'reauth_required',
  invalid_refresh_token: 'reauth_required',
  invalid_grant_type: 'invalid_input',
  missing_scope: 'insufficient_scope',
  no_permission: 'forbidden',
  not_allowed_token_type: 'forbidden',
  restricted_action: 'forbidden',
  not_in_channel: 'forbidden',
  channel_not_found: 'not_found',
  thread_not_found: 'not_found',
  is_archived: 'conflict',
  msg_too_long: 'invalid_input',
  no_text: 'invalid_input',
  invalid_arguments: 'invalid_input',
  invalid_cursor: 'invalid_input',
  invalid_blocks: 'invalid_input',
  ratelimited: 'rate_limited',
  rate_limited: 'rate_limited',
  invalid_client_id: 'not_configured',
  bad_client_secret: 'not_configured',
  bad_redirect_uri: 'not_configured',
  invalid_code: 'invalid_input',
  code_already_used: 'invalid_input',
  internal_error: 'unavailable',
  fatal_error: 'unavailable',
  service_unavailable: 'unavailable',
  request_timeout: 'unavailable',
}

const MESSAGES: Record<string, string> = {
  not_in_channel: 'The Nexefiy app isn’t a member of that channel. Invite it in Slack (/invite @app-name) and try again.',
  channel_not_found: 'Slack couldn’t find that channel, or the app can’t see it.',
  is_archived: 'That channel is archived.',
  missing_scope: 'The Slack connection is missing a permission this action needs. Reconnect it.',
}

export function normalizeSlackError(response: HttpResponse): IntegrationError {
  const providerCode = stringField(response.body, 'error')
  if (response.status === 429 || providerCode === 'ratelimited' || providerCode === 'rate_limited') {
    return new IntegrationError('rate_limited', {
      httpStatus: response.status,
      providerCode: providerCode ?? 'ratelimited',
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) ?? 1_000,
    })
  }
  if (response.status >= 500) return new IntegrationError('unavailable', { httpStatus: response.status, providerCode })
  const code: IntegrationErrorCode = (providerCode ? ERROR_CODES[providerCode] : undefined) ?? 'provider_error'
  return new IntegrationError(code, {
    httpStatus: response.status,
    providerCode,
    message: (providerCode && MESSAGES[providerCode]) ?? (providerCode ? `Slack returned “${providerCode}”.` : undefined),
  })
}

async function call(http: HttpClient, request: HttpRequest): Promise<{ body: Record<string, unknown>; headers: Headers }> {
  const response = await http.send(request)
  if (response.status !== 200 || !isRecord(response.body) || response.body.ok !== true) throw normalizeSlackError(response)
  return { body: response.body, headers: response.headers }
}

function bearer(context: ActionContext) {
  return { Authorization: `Bearer ${context.accessToken}` }
}

function basicAuth(client: OAuthClient): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}` }
}

// --- OAuth -------------------------------------------------------------------

function tokensFrom(body: Record<string, unknown>): TokenSet {
  const accessToken = stringField(body, 'access_token')
  if (!accessToken) throw new IntegrationError('provider_error', { message: 'Slack did not return a bot token.' })
  const refreshToken = stringField(body, 'refresh_token')
  const expiresAt = expiresAtFrom(body.expires_in)
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    scopes: splitScopes(body.scope, /,/),
  }
}

async function exchangeCode(http: HttpClient, client: OAuthClient, params: { code: string; redirectUri: string }) {
  const { body } = await call(http, {
    method: 'POST',
    url: `${API}/oauth.v2.access`,
    headers: basicAuth(client),
    form: { code: params.code, redirect_uri: params.redirectUri },
  })
  const tokens = tokensFrom(body)
  const team = isRecord(body.team) ? body.team : {}
  const enterprise = isRecord(body.enterprise) ? body.enterprise : {}
  const enterpriseInstall = body.is_enterprise_install === true
  const externalAccountId = enterpriseInstall ? stringField(enterprise, 'id') : stringField(team, 'id')
  if (!externalAccountId) throw new IntegrationError('provider_error', { message: 'Slack did not say which workspace was connected.' })
  const name = (enterpriseInstall ? stringField(enterprise, 'name') : stringField(team, 'name')) ?? externalAccountId
  return {
    tokens,
    account: {
      externalAccountId,
      label: name,
      metadata: {
        teamId: stringField(team, 'id') ?? null,
        teamName: stringField(team, 'name') ?? null,
        enterpriseId: stringField(enterprise, 'id') ?? null,
        enterpriseInstall,
        botUserId: stringField(body, 'bot_user_id') ?? null,
        appId: stringField(body, 'app_id') ?? null,
      },
      scopes: tokens.scopes,
    },
  }
}

async function refresh(http: HttpClient, client: OAuthClient, refreshToken: string): Promise<TokenSet> {
  const { body } = await call(http, {
    method: 'POST',
    url: `${API}/oauth.v2.access`,
    headers: basicAuth(client),
    form: { grant_type: 'refresh_token', refresh_token: refreshToken },
  })
  return tokensFrom(body)
}

async function revoke(http: HttpClient, _client: OAuthClient, tokens: TokenSet): Promise<void> {
  const { body } = await call(http, {
    method: 'POST',
    url: `${API}/auth.revoke`,
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    form: {},
  })
  if (body.revoked !== true) throw new IntegrationError('provider_error', { message: 'Slack did not confirm that the token was revoked.' })
}

// --- Channels ------------------------------------------------------------------

const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
  isMember: z.boolean(),
  memberCount: z.number().int().nullable(),
})

const listInput = z.object({
  nameContains: z
    .string()
    .trim()
    .toLowerCase()
    .max(80)
    .optional()
    .transform((value) => value || undefined),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => value || undefined),
})

const listOutput = z.object({ channels: z.array(channelSchema), nextCursor: z.string().nullable() })

const listChannelsAction = defineAction({
  key: 'slack.channels.list',
  title: 'List channels',
  description: 'Lists the workspace’s public channels, showing which ones the app is a member of.',
  input: listInput,
  output: listOutput,
  scopes: ['channels:read'],
  risk: 'read',
  approval: 'none',
  idempotency: { kind: 'read_only' },
  timeoutMs: 15_000,
  retry: READ_RETRY,
  rateLimitBucket: TIER2_BUCKET,
  exampleInput: { nameContains: 'sales' },
  summarize: (input) => (input.nameContains ? `List Slack channels containing “${input.nameContains}”` : 'List Slack channels'),
  redactOutput: (output) => ({ channelCount: output.channels.length, hasMore: output.nextCursor !== null }),
  async execute(context, input) {
    const params = new URLSearchParams({ types: 'public_channel', exclude_archived: 'true', limit: String(input.limit) })
    if (input.cursor) params.set('cursor', input.cursor)
    const { body } = await call(context.http, {
      method: 'GET',
      url: `${API}/conversations.list?${params.toString()}`,
      headers: bearer(context),
      rateLimitBuckets: [TIER2_BUCKET],
    })
    const channels = (Array.isArray(body.channels) ? body.channels : [])
      .filter(isRecord)
      .map((channel) => ({
        id: stringField(channel, 'id') ?? '',
        name: stringField(channel, 'name') ?? '',
        isPrivate: channel.is_private === true,
        isMember: channel.is_member === true,
        memberCount: typeof channel.num_members === 'number' ? channel.num_members : null,
      }))
      .filter((channel) => channel.id && (!input.nameContains || channel.name.includes(input.nameContains)))
    const nextCursor = stringField(isRecord(body.response_metadata) ? body.response_metadata : {}, 'next_cursor') ?? null
    return { channels, nextCursor }
  },
})

// --- Messages --------------------------------------------------------------------

/**
 * Slack's control characters. Escaping them means text from customers,
 * documents or models can't produce @channel/@here pings, user mentions or
 * disguised links (Slack: "Formatting text for app surfaces").
 */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const postInput = z.object({
  channel: z
    .string()
    .trim()
    .regex(/^[CG][A-Z0-9]{6,}$/, 'Use a channel id such as C0123456789 (find it with “List channels”).'),
  text: text(1, 4000),
  threadTs: z
    .string()
    .trim()
    .regex(/^\d+\.\d+$/, 'Use the message timestamp, such as 1712345678.123456.')
    .optional(),
})

const postOutput = z.object({ channel: z.string(), ts: z.string(), threadTs: z.string().nullable() })

const postMessageAction = defineAction({
  key: 'slack.messages.post',
  title: 'Post a message',
  description:
    'Posts a plain-text message to a channel (or a thread) as the Nexefiy app. Mentions and links in the text are shown literally, not triggered.',
  input: postInput,
  output: postOutput,
  scopes: ['chat:write'],
  risk: 'write_external',
  approval: 'default_required',
  idempotency: {
    kind: 'not_idempotent',
    description: 'Slack has no way to recognise a repeated message, so a message is never sent again once it may have arrived.',
  },
  timeoutMs: 15_000,
  retry: WRITE_RETRY,
  rateLimitBucket: POST_BUCKET,
  exampleInput: { channel: 'C0123456789', text: 'New lead: Dana Lee (Example Co) asked for a quote.' },
  summarize: (input) => `Post to Slack channel ${input.channel}: “${truncate(input.text, 80)}”`,
  redactInput: (input) => ({
    channel: input.channel,
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    textPreview: truncate(input.text, 120),
    textLength: input.text.length,
  }),
  async execute(context, input) {
    const { body } = await call(context.http, {
      method: 'POST',
      url: `${API}/chat.postMessage`,
      headers: bearer(context),
      json: {
        channel: input.channel,
        text: escapeSlackText(input.text),
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      },
      rateLimitBuckets: [`${POST_BUCKET}:${input.channel.toLowerCase()}`, DEFAULT_BUCKET],
    })
    const ts = stringField(body, 'ts')
    if (!ts) throw new IntegrationError('provider_error', { message: 'Slack accepted the message but returned no timestamp.' })
    return { channel: stringField(body, 'channel') ?? input.channel, ts, threadTs: input.threadTs ?? null }
  },
})

// --- Connector -------------------------------------------------------------------

export const slackConnector: ConnectorDefinition = {
  provider: 'slack',
  displayName: 'Slack',
  category: 'communication',
  description: 'Post updates to Slack channels as the Nexefiy app.',
  docsUrl: 'https://docs.slack.dev/reference/methods',
  feature: 'slackIntegration',
  auth: {
    kind: 'oauth2',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    scopeSeparator: ',',
    baseScopes: [],
    tokenRefresh: 'when_rotation_enabled',
    revocation: 'Revokes the bot token at Slack (auth.revoke). Without token rotation this removes the app’s authorization.',
    exchangeCode,
    refresh,
    revoke,
  },
  rateLimits: {
    [DEFAULT_BUCKET]: { bucket: DEFAULT_BUCKET, limit: 50, windowSeconds: 60, source: 'Slack: Tier 3, 50+ per minute' },
    [TIER2_BUCKET]: { bucket: TIER2_BUCKET, limit: 20, windowSeconds: 60, source: 'Slack: Tier 2, 20+ per minute (conversations.list)' },
    [POST_BUCKET]: { bucket: POST_BUCKET, limit: 1, windowSeconds: 1, source: 'Slack: chat.postMessage about 1 per second per channel' },
  },
  defaultRateLimitBucket: DEFAULT_BUCKET,
  requestTimeoutMs: 10_000,
  async healthCheck(context) {
    const { body, headers } = await call(context.http, { method: 'POST', url: `${API}/auth.test`, headers: bearer(context), form: {} })
    const teamId = stringField(body, 'team_id')
    const expected = context.connection.metadata.enterpriseInstall === true ? stringField(body, 'enterprise_id') : teamId
    if (expected && expected !== context.connection.externalAccountId) {
      return { status: 'degraded', message: 'Slack answered for a different workspace than the one connected.' }
    }
    const granted = splitScopes(headers.get('x-oauth-scopes'), /,/)
    return {
      status: 'healthy',
      message: `Slack accepted the bot token for ${stringField(body, 'team') ?? 'the workspace'}.`,
      ...(granted.length ? { grantedScopes: granted } : {}),
    }
  },
  normalizeError: normalizeSlackError,
  actions: [listChannelsAction, postMessageAction],
}

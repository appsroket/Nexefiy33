// Single source of truth for every environment variable Nexefiy reads.
// Drives validation (core.ts), the `npm run env:check` report, and the
// credential inventory in docs/credential-setup.md. Keep all three in sync.

import {
  emailSender,
  httpUrl,
  matches,
  minLength,
  oneOf,
  startsWithAny,
  supabaseLegacyJwt,
  type Validator,
} from './validators'

export type FeatureKey =
  | 'core'
  | 'supabaseAdmin'
  | 'ai'
  | 'embeddings'
  | 'email'
  | 'contactForm'
  | 'billing'
  | 'credentialEncryption'
  | 'googleIntegration'
  | 'slackIntegration'
  | 'hubspotIntegration'
  | 'backgroundJobs'
  | 'errorMonitoring'
  | 'cronAuth'

export type OptionalFeatureKey = Exclude<FeatureKey, 'core'>

export type Exposure = 'public' | 'server'

export interface EnvVarDefinition {
  name: string
  feature: FeatureKey
  /** `public` values are inlined into browser bundles and must never be secrets. */
  exposure: Exposure
  /** Secret values are never printed, logged, or included in error messages. */
  secret: boolean
  /** Not needed for the feature to be configured (has a default or is an alternative). */
  optional?: boolean
  description: string
  validate: Validator
  /** Completes the sentence "<NAME> ..." when the value is invalid. Never includes the value. */
  formatHint: string
  whereToFind: string
}

export interface FeatureDefinition {
  key: FeatureKey
  label: string
  /** What stops working while this feature is unavailable. */
  unlocks: string
  dependsOn: OptionalFeatureKey[]
  guide: string
}

const GUIDE = 'docs/credential-setup.md'

export const FEATURES: Record<FeatureKey, FeatureDefinition> = {
  core: {
    key: 'core',
    label: 'Core application (Supabase public access)',
    unlocks: 'the whole application; it will not start without these',
    dependsOn: [],
    guide: `${GUIDE}#a-supabase`,
  },
  supabaseAdmin: {
    key: 'supabaseAdmin',
    label: 'Supabase privileged server access',
    unlocks: 'background workers, inbound webhooks, billing sync, and other operations that must bypass RLS',
    dependsOn: [],
    guide: `${GUIDE}#a-supabase`,
  },
  ai: {
    key: 'ai',
    label: 'AI model provider',
    unlocks: 'AI employees, chat, and natural-language workflow generation',
    dependsOn: [],
    guide: `${GUIDE}#b-ai-model-provider`,
  },
  embeddings: {
    key: 'embeddings',
    label: 'Embeddings (Voyage AI)',
    unlocks: 'indexing knowledge documents and semantic knowledge search',
    dependsOn: [],
    guide: `${GUIDE}#b2-embeddings-voyage-ai`,
  },
  email: {
    key: 'email',
    label: 'Transactional email (Resend)',
    unlocks: 'invitation emails, approval notifications, and other app-sent email',
    dependsOn: [],
    guide: `${GUIDE}#c-email-resend`,
  },
  contactForm: {
    key: 'contactForm',
    label: 'Website contact form',
    unlocks: 'messages sent from the public contact form (delivered by email)',
    dependsOn: ['email'],
    guide: `${GUIDE}#c2-website-contact-form`,
  },
  billing: {
    key: 'billing',
    label: 'Billing (Stripe)',
    unlocks: 'subscriptions, checkout, customer portal, and plan entitlements sync',
    dependsOn: [],
    guide: `${GUIDE}#d-billing-stripe`,
  },
  credentialEncryption: {
    key: 'credentialEncryption',
    label: 'Customer credential encryption',
    unlocks: 'storing customer integration tokens (required by every OAuth integration)',
    dependsOn: [],
    guide: `${GUIDE}#e1-customer-credential-encryption`,
  },
  googleIntegration: {
    key: 'googleIntegration',
    label: 'Google integration (Gmail, Calendar)',
    unlocks: 'connecting Gmail and Google Calendar accounts',
    dependsOn: ['credentialEncryption', 'supabaseAdmin'],
    guide: `${GUIDE}#e2-google-gmail-and-calendar`,
  },
  slackIntegration: {
    key: 'slackIntegration',
    label: 'Slack integration',
    unlocks: 'connecting Slack workspaces and receiving Slack events',
    dependsOn: ['credentialEncryption', 'supabaseAdmin'],
    guide: `${GUIDE}#e3-slack`,
  },
  hubspotIntegration: {
    key: 'hubspotIntegration',
    label: 'HubSpot CRM integration',
    unlocks: 'connecting HubSpot portals',
    dependsOn: ['credentialEncryption', 'supabaseAdmin'],
    guide: `${GUIDE}#e4-hubspot-crm`,
  },
  backgroundJobs: {
    key: 'backgroundJobs',
    label: 'Background execution (Trigger.dev)',
    unlocks: 'durable workflow runs, approvals that wait, retries, and schedules',
    dependsOn: [],
    guide: `${GUIDE}#e5-background-execution-triggerdev`,
  },
  errorMonitoring: {
    key: 'errorMonitoring',
    label: 'Error monitoring (Sentry)',
    unlocks: 'error reporting to Sentry',
    dependsOn: [],
    guide: `${GUIDE}#e6-error-monitoring-sentry`,
  },
  cronAuth: {
    key: 'cronAuth',
    label: 'Scheduled-job authorization',
    unlocks: 'cron endpoints (they reject every request while this is unset)',
    dependsOn: [],
    guide: `${GUIDE}#e7-scheduled-job-authorization`,
  },
}

export const ENV_VARS: EnvVarDefinition[] = [
  // --- Core ---------------------------------------------------------------
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    feature: 'core',
    exposure: 'public',
    secret: false,
    description: 'Supabase project API URL.',
    validate: httpUrl,
    formatHint: 'must be an https URL (http is allowed only for localhost)',
    whereToFind: 'Supabase Dashboard → Project Settings → Data API → Project URL',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    feature: 'core',
    exposure: 'public',
    secret: false,
    description: 'Supabase publishable key; all access it grants is governed by RLS.',
    validate: (value) => startsWithAny('sb_publishable_')(value) || supabaseLegacyJwt('anon')(value),
    formatHint: 'must be a publishable key starting with "sb_publishable_" (or a legacy anon JWT)',
    whereToFind: 'Supabase Dashboard → Project Settings → API Keys → Publishable key',
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    feature: 'core',
    exposure: 'public',
    secret: false,
    optional: true,
    description:
      'Public base URL of the app, used for OAuth redirects and email links. Defaults to http://localhost:3000 in development and https://$VERCEL_URL in preview; required in production.',
    validate: httpUrl,
    formatHint: 'must be an https URL (http is allowed only for localhost)',
    whereToFind: 'Your deployment domain, e.g. https://nexefiy.com',
  },
  {
    name: 'APP_ENV',
    feature: 'core',
    exposure: 'server',
    secret: false,
    optional: true,
    description:
      'Deployment environment: development, preview, or production. Defaults from VERCEL_ENV, then NODE_ENV.',
    validate: oneOf('development', 'preview', 'production'),
    formatHint: 'must be one of: development, preview, production',
    whereToFind: 'Set per environment in Vercel; usually unnecessary because VERCEL_ENV is detected',
  },

  // --- Supabase privileged access ------------------------------------------
  {
    name: 'SUPABASE_SECRET_KEY',
    feature: 'supabaseAdmin',
    exposure: 'server',
    secret: true,
    description: 'Supabase secret key. Bypasses RLS; server and worker code only.',
    validate: startsWithAny('sb_secret_'),
    formatHint: 'must be a secret key starting with "sb_secret_"',
    whereToFind: 'Supabase Dashboard → Project Settings → API Keys → Secret keys → Add new secret key',
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    feature: 'supabaseAdmin',
    exposure: 'server',
    secret: true,
    optional: true,
    description:
      'Legacy service_role JWT. Only for projects that cannot use the new secret keys; ignored when SUPABASE_SECRET_KEY is set.',
    validate: supabaseLegacyJwt('service_role'),
    formatHint: 'must be a legacy JWT whose role claim is "service_role"',
    whereToFind: 'Supabase Dashboard → Project Settings → API Keys → Legacy API keys → service_role',
  },

  // --- AI model provider ---------------------------------------------------
  {
    name: 'AI_PROVIDER',
    feature: 'ai',
    exposure: 'server',
    secret: false,
    optional: true,
    description: 'Selected model provider. Defaults to "anthropic". Only the selected provider\'s key is required.',
    validate: oneOf('anthropic', 'openai'),
    formatHint: 'must be one of: anthropic, openai',
    whereToFind: 'Choose; see docs/architecture-decisions.md ADR-015',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    feature: 'ai',
    exposure: 'server',
    secret: true,
    optional: true,
    description: 'Anthropic API key. Required when AI_PROVIDER is anthropic (the default).',
    validate: startsWithAny('sk-ant-'),
    formatHint: 'must be an Anthropic API key starting with "sk-ant-"',
    whereToFind: 'https://console.anthropic.com/ → Settings → API Keys',
  },
  {
    name: 'OPENAI_API_KEY',
    feature: 'ai',
    exposure: 'server',
    secret: true,
    optional: true,
    description: 'OpenAI API key. Required only when AI_PROVIDER is openai.',
    validate: startsWithAny('sk-'),
    formatHint: 'must be an OpenAI API key starting with "sk-"',
    whereToFind: 'https://platform.openai.com/api-keys',
  },

  // --- Embeddings ------------------------------------------------------------
  {
    name: 'VOYAGE_API_KEY',
    feature: 'embeddings',
    exposure: 'server',
    secret: true,
    description: 'Voyage AI API key for the voyage-4 embedding model (1024 dimensions).',
    validate: minLength(20),
    formatHint: 'is too short to be a Voyage AI API key',
    whereToFind: 'https://dashboard.voyageai.com/ → API Keys',
  },

  // --- Email ---------------------------------------------------------------
  {
    name: 'RESEND_API_KEY',
    feature: 'email',
    exposure: 'server',
    secret: true,
    description: 'Resend API key (sending access, restricted to the verified domain, is recommended).',
    validate: startsWithAny('re_'),
    formatHint: 'must be a Resend API key starting with "re_"',
    whereToFind: 'https://resend.com/api-keys',
  },
  {
    name: 'EMAIL_FROM',
    feature: 'email',
    exposure: 'server',
    secret: false,
    description: 'Default sender, e.g. "Nexefiy <notifications@mail.nexefiy.com>". Its domain must be verified in Resend.',
    validate: emailSender,
    formatHint: 'must be "Name <address@domain>" or "address@domain"',
    whereToFind: 'An address on a domain verified at https://resend.com/domains',
  },

  // --- Website contact form ------------------------------------------------
  {
    name: 'CONTACT_FORM_TO',
    feature: 'contactForm',
    exposure: 'server',
    secret: false,
    description: 'Inbox that receives messages from the public contact form. Never shown on the website.',
    validate: matches(/^[^s@<>]+@[^s@<>]+.[^s@<>]+$/),
    formatHint: 'must be a single email address, e.g. hello@example.com',
    whereToFind: 'A mailbox your team reads',
  },

  // --- Billing -------------------------------------------------------------
  {
    name: 'STRIPE_SECRET_KEY',
    feature: 'billing',
    exposure: 'server',
    secret: true,
    description: 'Stripe secret or restricted key. Use test-mode keys outside production.',
    validate: startsWithAny('sk_test_', 'sk_live_', 'rk_test_', 'rk_live_'),
    formatHint: 'must start with "sk_test_", "sk_live_", "rk_test_", or "rk_live_"',
    whereToFind: 'https://dashboard.stripe.com/apikeys (toggle Test mode for development)',
  },
  {
    name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    feature: 'billing',
    exposure: 'public',
    secret: false,
    description: 'Stripe publishable key for Stripe.js.',
    validate: startsWithAny('pk_test_', 'pk_live_'),
    formatHint: 'must start with "pk_test_" or "pk_live_"',
    whereToFind: 'https://dashboard.stripe.com/apikeys',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    feature: 'billing',
    exposure: 'server',
    secret: true,
    description: 'Signing secret of the Stripe webhook endpoint for this environment.',
    validate: startsWithAny('whsec_'),
    formatHint: 'must start with "whsec_"',
    whereToFind: 'Stripe Dashboard → Developers → Webhooks → endpoint → Signing secret (or `stripe listen` locally)',
  },

  // --- Customer credential encryption --------------------------------------
  {
    name: 'INTEGRATION_ENCRYPTION_KEYS',
    feature: 'credentialEncryption',
    exposure: 'server',
    secret: true,
    description:
      'Keyring for AES-256-GCM encryption of customer integration credentials: comma-separated "keyId:base64Key" entries, each key 32 bytes.',
    validate: minLength(1),
    formatHint: 'must be comma-separated "keyId:base64Key" entries with 32-byte keys',
    whereToFind: 'Generate with `npm run env:generate-key`; store a backup in your secret manager',
  },
  {
    name: 'INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID',
    feature: 'credentialEncryption',
    exposure: 'server',
    secret: false,
    description: 'Id of the keyring entry used to encrypt new credentials.',
    validate: matches(/^[A-Za-z0-9_-]{1,32}$/),
    formatHint: 'must be 1–32 characters of letters, digits, "_" or "-"',
    whereToFind: 'The keyId of the newest entry in INTEGRATION_ENCRYPTION_KEYS',
  },

  // --- Google --------------------------------------------------------------
  {
    name: 'GOOGLE_OAUTH_CLIENT_ID',
    feature: 'googleIntegration',
    exposure: 'server',
    secret: false,
    description: 'OAuth 2.0 web client id used for Gmail and Calendar connections.',
    validate: matches(/^[\w-]+\.apps\.googleusercontent\.com$/),
    formatHint: 'must end with ".apps.googleusercontent.com"',
    whereToFind: 'Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs',
  },
  {
    name: 'GOOGLE_OAUTH_CLIENT_SECRET',
    feature: 'googleIntegration',
    exposure: 'server',
    secret: true,
    description: 'OAuth 2.0 client secret for the client above.',
    validate: minLength(10),
    formatHint: 'is too short to be a Google client secret',
    whereToFind: 'Same OAuth client → Client secrets',
  },

  // --- Slack ---------------------------------------------------------------
  {
    name: 'SLACK_CLIENT_ID',
    feature: 'slackIntegration',
    exposure: 'server',
    secret: false,
    description: 'Slack app client id.',
    validate: matches(/^\d+\.\d+$/),
    formatHint: 'must look like "1234567890.1234567890"',
    whereToFind: 'https://api.slack.com/apps → your app → Basic Information → App Credentials',
  },
  {
    name: 'SLACK_CLIENT_SECRET',
    feature: 'slackIntegration',
    exposure: 'server',
    secret: true,
    description: 'Slack app client secret.',
    validate: minLength(16),
    formatHint: 'is too short to be a Slack client secret',
    whereToFind: 'Slack app → Basic Information → App Credentials',
  },
  {
    name: 'SLACK_SIGNING_SECRET',
    feature: 'slackIntegration',
    exposure: 'server',
    secret: true,
    description: 'Verifies that inbound Slack requests come from Slack.',
    validate: minLength(16),
    formatHint: 'is too short to be a Slack signing secret',
    whereToFind: 'Slack app → Basic Information → App Credentials → Signing Secret',
  },

  // --- HubSpot -------------------------------------------------------------
  {
    name: 'HUBSPOT_CLIENT_ID',
    feature: 'hubspotIntegration',
    exposure: 'server',
    secret: false,
    description: 'HubSpot public app client id.',
    validate: minLength(8),
    formatHint: 'is too short to be a HubSpot client id',
    whereToFind: 'HubSpot developer account → Apps → your app → Auth',
  },
  {
    name: 'HUBSPOT_CLIENT_SECRET',
    feature: 'hubspotIntegration',
    exposure: 'server',
    secret: true,
    description: 'HubSpot public app client secret (also used to verify webhook signatures).',
    validate: minLength(8),
    formatHint: 'is too short to be a HubSpot client secret',
    whereToFind: 'HubSpot developer account → Apps → your app → Auth',
  },

  // --- Background execution ------------------------------------------------
  {
    name: 'TRIGGER_SECRET_KEY',
    feature: 'backgroundJobs',
    exposure: 'server',
    secret: true,
    description: 'Trigger.dev secret key for this environment.',
    validate: startsWithAny('tr_'),
    formatHint: 'must be a Trigger.dev secret key starting with "tr_"',
    whereToFind: 'Trigger.dev dashboard → project → API keys',
  },
  {
    name: 'TRIGGER_PROJECT_REF',
    feature: 'backgroundJobs',
    exposure: 'server',
    secret: false,
    description: 'Trigger.dev project reference.',
    validate: startsWithAny('proj_'),
    formatHint: 'must start with "proj_"',
    whereToFind: 'Trigger.dev dashboard → project settings',
  },

  // --- Error monitoring ----------------------------------------------------
  {
    name: 'SENTRY_DSN',
    feature: 'errorMonitoring',
    exposure: 'server',
    secret: false,
    description: 'Sentry DSN for server-side error reporting.',
    validate: httpUrl,
    formatHint: 'must be an https URL',
    whereToFind: 'Sentry → Project Settings → Client Keys (DSN)',
  },

  // --- Scheduled jobs ------------------------------------------------------
  {
    name: 'CRON_SECRET',
    feature: 'cronAuth',
    exposure: 'server',
    secret: true,
    description: 'Shared secret Vercel Cron sends as "Authorization: Bearer <CRON_SECRET>".',
    validate: minLength(32),
    formatHint: 'must be at least 32 characters',
    whereToFind: 'Generate with `openssl rand -base64 32`',
  },
]

export const ENV_VARS_BY_NAME: ReadonlyMap<string, EnvVarDefinition> = new Map(ENV_VARS.map((v) => [v.name, v]))

export function varsForFeature(feature: FeatureKey): EnvVarDefinition[] {
  return ENV_VARS.filter((v) => v.feature === feature)
}

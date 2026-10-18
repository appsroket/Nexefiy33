# Environment Variables

Reference for every variable Nexefiy reads. The source of truth is `src/lib/env/catalog.ts`; `.env.example` and this table must match it (a test enforces the `.env.example` part). How to obtain each value: [credential-setup.md](credential-setup.md).

## Modules

| Module | Use from | Purpose |
|---|---|---|
| `src/lib/env/server.ts` | server components, route handlers, server actions, workers | `getServerEnv()`, `requireFeature('ai')`, `isFeatureConfigured('email')`, `getFeatureStatus(...)`. Imports `server-only`, so importing it from client code fails the build. |
| `src/lib/env/public.ts` | client and server | `getPublicEnv()` — only `NEXT_PUBLIC_*` values, each referenced literally so Next.js can inline it. |
| `src/lib/env/core.ts` | scripts, tests | `parseEnvironment(raw)` — pure parser behind both. |

Usage pattern: check optional features **at the point of use**, not at module load:

```ts
import { requireFeature } from '@/lib/env/server'

export async function POST() {
  const billing = requireFeature('billing') // throws FeatureUnavailableError with setup instructions
  // ...
}
```

## Validation behaviour

| Situation | Result |
|---|---|
| Core variable missing or malformed | `EnvValidationError` at startup, listing every problem and where to find each value |
| Secret-looking value, or a name containing SECRET / SERVICE_ROLE / PASSWORD / PRIVATE_KEY, in a `NEXT_PUBLIC_*` variable | `EnvValidationError` at startup — always, in every environment |
| None of a feature's variables set | feature `not_configured`; only that feature is unavailable |
| Some set, others missing or malformed | feature `misconfigured`; only that feature is unavailable |
| Feature configured but a dependency isn't (e.g. Google without the encryption keyring) | feature `blocked` |
| Empty or whitespace-only value | treated as unset |

Error and status messages name variables but **never include values**. The parsed env object hides secrets from `JSON.stringify` and `console.log`.

## Reference

Exposure: **public** = inlined into browser bundles (must never be secret) · **server** = server and workers only.

| Variable | Feature | Exposure | Secret | Required | Format |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | core | public | no | **always** | https URL (http only for localhost) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | core | public | no | **always** | `sb_publishable_…` (legacy anon JWT accepted with warning) |
| `NEXT_PUBLIC_APP_URL` | core | public | no | **production**; defaults in dev/preview | https URL |
| `APP_ENV` | core | server | no | no — from `VERCEL_ENV`/`NODE_ENV` | `development` \| `preview` \| `production` |
| `SUPABASE_SECRET_KEY` | supabaseAdmin | server | **yes** | for privileged ops | `sb_secret_…` |
| `SUPABASE_SERVICE_ROLE_KEY` | supabaseAdmin | server | **yes** | legacy alternative | JWT with role `service_role` |
| `SUPABASE_DB_PASSWORD` | — (CLI only) | — | **yes** | for migrations | — |
| `AI_PROVIDER` | ai | server | no | no — default `anthropic` | `anthropic` \| `openai` |
| `ANTHROPIC_API_KEY` | ai | server | **yes** | if provider is anthropic | `sk-ant-…` |
| `OPENAI_API_KEY` | ai | server | **yes** | if provider is openai | `sk-…` |
| `VOYAGE_API_KEY` | embeddings | server | **yes** | for knowledge indexing and search | — |
| `RESEND_API_KEY` | email | server | **yes** | for email | `re_…` |
| `EMAIL_FROM` | email | server | no | for email | `Name <a@domain>` or `a@domain` |
| `CONTACT_FORM_TO` | contactForm | server | no | for the website contact form (needs email) | `a@domain` |
| `STRIPE_SECRET_KEY` | billing | server | **yes** | for billing | `sk_/rk_` + `test_/live_` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | billing | public | no | for billing | `pk_test_…` / `pk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | billing | server | **yes** | for billing | `whsec_…` |
| `INTEGRATION_ENCRYPTION_KEYS` | credentialEncryption | server | **yes** | for any integration | `id:base64(32 bytes)[,…]` |
| `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID` | credentialEncryption | server | no | for any integration | id present in the keyring |
| `GOOGLE_OAUTH_CLIENT_ID` | googleIntegration | server | no | for Google | `….apps.googleusercontent.com` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | googleIntegration | server | **yes** | for Google | — |
| `SLACK_CLIENT_ID` | slackIntegration | server | no | for Slack | `digits.digits` |
| `SLACK_CLIENT_SECRET` | slackIntegration | server | **yes** | for Slack | — |
| `SLACK_SIGNING_SECRET` | slackIntegration | server | **yes** | for Slack | — |
| `HUBSPOT_CLIENT_ID` | hubspotIntegration | server | no | for HubSpot | — |
| `HUBSPOT_CLIENT_SECRET` | hubspotIntegration | server | **yes** | for HubSpot | — |
| `TRIGGER_SECRET_KEY` | backgroundJobs | server | **yes** | for durable runs | `tr_…` |
| `TRIGGER_PROJECT_REF` | backgroundJobs | server | no | for durable runs | `proj_…` |
| `SENTRY_DSN` | errorMonitoring | server | no | optional | https URL |
| `CRON_SECRET` | cronAuth | server | **yes** | for cron routes | ≥ 32 characters |

Feature dependencies: `googleIntegration`, `slackIntegration`, `hubspotIntegration` → require `credentialEncryption` and `supabaseAdmin`.

## Adding a variable

1. Add it to `ENV_VARS` in `src/lib/env/catalog.ts` (feature, exposure, secret flag, validator, format hint, where to find it).
2. Read it in `src/lib/env/core.ts` for its feature and expose it on `ServerEnv`.
3. Add a placeholder to `.env.example` (blank if secret) — the test suite fails otherwise.
4. Document it here and in [credential-setup.md](credential-setup.md).
5. Never use the `NEXT_PUBLIC_` prefix for a secret.

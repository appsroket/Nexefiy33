# Credential Setup Guide

How to obtain, configure, verify, and rotate every credential Nexefiy uses. The variable reference is in [environment-variables.md](environment-variables.md); the inventory (what is selected and when it's needed) is in [api-credentials.md](api-credentials.md).

> **Never** paste real credentials into code, docs, issues, commits, chat, or prompts. Put them in `.env.local` (git-ignored) locally, and in Vercel / Trigger.dev environment settings when deployed. If a credential is ever exposed, rotate it (see [Leaked credential checklist](#leaked-credential-checklist)).

## How configuration works

- `src/lib/env` validates configuration once per process ([ADR-017](architecture-decisions.md)).
- **Core** (Supabase URL + publishable key, and the app URL in production) is required. If it's missing, the app refuses to start and lists what to set.
- **Every other credential enables exactly one feature.** If it's missing or malformed, only that feature is disabled; the error says what to set and links to the right section here. Features that depend on it (e.g. integrations depend on credential encryption) report `blocked`.
- A secret-looking value or name in any `NEXT_PUBLIC_*` variable stops startup — those variables are shipped to browsers.
- Check at any time — no values are printed:

```bash
npm run env:check
```

```bash
npm run env:check:connectivity
```

## Environments

| | Development (local) | Preview (Vercel preview deployments) | Production |
|---|---|---|---|
| Where values live | `.env.local` | Vercel → Environment Variables → *Preview* | Vercel → Environment Variables → *Production* |
| `APP_ENV` | auto (`development`) | auto from `VERCEL_ENV` | auto from `VERCEL_ENV` |
| `NEXT_PUBLIC_APP_URL` | defaults to `http://localhost:3000` | defaults to `https://$VERCEL_URL`; set a stable alias for OAuth | **required**, e.g. `https://nexefiy.com` (the website and the application share one origin, ADR-020) |
| Supabase | dev/test project (ADR-010) | dev/test project or a Supabase branch | production project |
| Stripe | test mode (`sk_test_`) | test mode | live mode (`sk_live_`/`rk_live_`) — live keys are **rejected** elsewhere |
| OAuth apps (Google/Slack/HubSpot) | separate dev app, localhost redirects | dev app, stable preview URL | production app, production redirects |
| Trigger.dev | `tr_dev_` key | preview/staging key | `tr_prod_` key |
| Resend | sending key on a test subdomain | same as dev | sending key restricted to production domain |
| Encryption keyring | its own keys | its own keys | its own keys, backed up |

Use **different credentials per environment** so a leaked development key can't touch production data, and so rotating one environment doesn't break the others.

After changing Vercel variables, **redeploy** — values are read at build/start time.

## URLs to register with providers

Replace `{APP_URL}` with the environment's `NEXT_PUBLIC_APP_URL`. `npm run env:check` prints the exact list for the current environment. Paths are defined in `src/lib/config/endpoints.ts`; the routes are implemented in later phases.

| Provider | What | URL |
|---|---|---|
| Supabase Auth | Redirect URL (allow list) | `{APP_URL}/auth/callback` |
| Google | OAuth authorized redirect URI | `{APP_URL}/api/integrations/google/callback` |
| Google | Gmail push (Pub/Sub push endpoint) | `{APP_URL}/api/webhooks/google` |
| Slack | OAuth redirect URL | `{APP_URL}/api/integrations/slack/callback` |
| Slack | Event Subscriptions request URL | `{APP_URL}/api/webhooks/slack` |
| HubSpot | OAuth redirect URL | `{APP_URL}/api/integrations/hubspot/callback` |
| HubSpot | Webhook target URL | `{APP_URL}/api/webhooks/hubspot` |
| Stripe | Webhook endpoint | `{APP_URL}/api/webhooks/stripe` |
| Vercel Cron | Job paths | `/api/cron/<job>` (in `vercel.json`) |

Slack and Stripe webhooks need a publicly reachable HTTPS URL. Locally, use `stripe listen` (below) for Stripe and a tunnel (e.g. `cloudflared tunnel` or `ngrok`) for Slack.

---

## A. Supabase

Dashboard: <https://supabase.com/dashboard> · Project `rnqrqconfbcrmszllxgu` (eu-north-1)

| Variable | Exposure | Required | Where |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | yes | Project Settings → Data API → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | yes | Project Settings → API Keys → Publishable key (`sb_publishable_…`) |
| `SUPABASE_SECRET_KEY` | **server** | for workers, webhooks, billing sync | Project Settings → API Keys → Secret keys → *Add new secret key* (`sb_secret_…`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **server** | legacy projects only | Project Settings → API Keys → Legacy API keys → `service_role` |
| `SUPABASE_DB_PASSWORD` | CLI only | for `supabase db push` | Project Settings → Database |

**Principles**
- The publishable key is safe in browsers *only because* every table has RLS. User-facing reads and writes go through the publishable key + the user's session.
- The secret key bypasses RLS. Use it only where no user session exists (workers, webhooks, billing sync), only in `server-only` modules, and always scope queries by `organization_id`. Prefer a narrowly scoped `security definer` function over broad secret-key access.
- This project uses the new key system. Don't set `SUPABASE_SERVICE_ROLE_KEY`; it exists only for older projects. If both are set, the secret key wins and a warning is shown.

**Auth settings** (Authentication → URL Configuration): Site URL = `{APP_URL}`; Redirect URLs: `http://localhost:3000/**`, your preview alias, and the production URL. Sign-up and password-reset emails link to `{APP_URL}/auth/callback?next=…`, so the allow list must match the query string too (`/**` does). If a redirect isn't allowed, Supabase falls back to the Site URL; the app finishes those links as well.

**Auth emails:**
- Keep **Confirm email** on (Authentication → Sign In / Providers → Email). The app handles both cases, but with confirmation off anyone can sign up with someone else's address.
- Supabase's built-in email service only delivers to members of your Supabase team and is heavily rate-limited. Set up custom SMTP (Resend, section C) before anyone else signs up.
- The default email templates use PKCE links, which only work in the browser that asked for the email. To make links work on any device, change the templates (Authentication → Emails) to token-hash links handled by `/auth/confirm`, for example `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` for *Confirm signup* and `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery` for *Reset password*.
- Consider turning on leaked-password protection and a minimum password length of 8 (Authentication → Sign In / Providers → Email); the app enforces 8 characters too.

**Connectivity check:** `GET /auth/v1/settings` with the publishable key, and for the secret key `GET /auth/v1/admin/users?per_page=1` (requires privileged access; the response body is discarded unread).

**Rotation:** create a new secret key → update Vercel/Trigger.dev/`.env.local` → redeploy → delete the old key. Publishable keys rotate the same way. With the new key system each key can be revoked independently, without the JWT-secret rotation the legacy keys required. Plan to **disable the legacy `anon`/`service_role` keys** once nothing uses them.

## B. AI model provider

Selected: **Anthropic** ([ADR-015](architecture-decisions.md)). Console: <https://console.anthropic.com/>

| Variable | Exposure | Required |
|---|---|---|
| `AI_PROVIDER` | server | no — defaults to `anthropic` |
| `ANTHROPIC_API_KEY` | **server** | when provider is `anthropic` |
| `OPENAI_API_KEY` | **server** | only when `AI_PROVIDER=openai` (adapter not implemented yet) |

Steps:
1. Console → Settings → Workspaces: create a workspace per environment (e.g. `nexefiy-dev`, `nexefiy-prod`) so usage, limits, and keys are separated.
2. Set a monthly spend limit on each workspace.
3. Settings → API Keys → *Create key* in that workspace; copy it once into the right environment.

Only the selected provider's key is required; setting the other one produces a warning that it's unused.

**Used by:** AI employee drafting (Claude Opus 5.5), every test-playground run (Phase 9) and every employee task (Phase 10), at the employee's tier: Claude Haiku 5.5, Sonnet 5.5 or Opus 5.5. Without the key, drafting falls back to labelled keyword rules, the playground refuses to run, and assigned tasks stay queued (nothing is simulated). Test runs and tasks are billed to this key; each employee's per-task limit and monthly budget cap its own spend, and the console spend limit caps everything. Tasks also need `SUPABASE_SECRET_KEY`; tasks that use HubSpot or Slack need the credential encryption keys and a connected account. `/api/cron/tasks` (with `CRON_SECRET`) expires overdue approvals and runs queued tasks.

**Connectivity check:** lists one model via the Models API (`GET /v1/models`) — free and read-only.
**Rotation:** create a new key → deploy it → confirm with the connectivity check → disable the old key in the console.

### B2. Embeddings (Voyage AI)

Selected: **Voyage AI `voyage-4`, 1024 dimensions** ([ADR-008](architecture-decisions.md)). Dashboard: <https://dashboard.voyageai.com/>

| Variable | Exposure | Required for |
|---|---|---|
| `VOYAGE_API_KEY` | **server** | indexing knowledge and semantic search |

The dimension is fixed by the database (`knowledge_chunks.embedding vector(1024)`) and by `src/lib/config/embeddings.ts`; a test fails if they disagree. Switching model or dimension requires a migration and re-embedding every chunk — vectors from different models are not comparable.

Steps: create an organization in the Voyage dashboard, set a usage limit, create an API key per environment.

**Connectivity check:** format only for now (the embedding client arrives with the knowledge phase).
**Rotation:** create a new key → deploy → delete the old key.

## C. Email (Resend)

Selected: **Resend** ([ADR-016](architecture-decisions.md)). Dashboard: <https://resend.com/api-keys>

| Variable | Exposure | Required for email |
|---|---|---|
| `RESEND_API_KEY` | **server** | yes |
| `EMAIL_FROM` | server | yes, e.g. `Nexefiy <notifications@mail.nexefiy.com>` |

**Domain verification** (do this first):
1. Resend → Domains → *Add domain*. Use a sending subdomain such as `mail.nexefiy.com` so the root domain's reputation is isolated.
2. Add the DNS records Resend shows (SPF `TXT` and `MX` on the bounce subdomain, DKIM `TXT`) at your DNS provider. Add a DMARC record (`_dmarc` `TXT`, start with `p=none`) if you don't have one.
3. Wait until the domain shows **Verified**. Unverified domains can only send to your own account address.

**API keys:** create a **Sending access** key restricted to the verified domain for the app. Keep any full-access key out of the app. Use a separate sending key for Supabase SMTP.

**Supabase Auth email via Resend SMTP** (Supabase → Authentication → Emails → SMTP settings): host `smtp.resend.com`, port `465`, username `resend`, password = a Resend sending key, sender = an address on the verified domain.

**Delivery testing:**
- `npm run env:check:connectivity` — authenticates the key without sending. A sending-access key is reported as "sending-access key".
- To send one real API request to Resend's test inbox (nothing is delivered to a person):

```bash
npm run env:check -- --connectivity --send-test-email
```

- Resend test addresses for later integration tests: `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`.

**Rotation:** create a new sending key → deploy → verify → delete the old key.

### C2. Website contact form

| Variable | Exposure | Required for the contact form |
|---|---|---|
| `CONTACT_FORM_TO` | server | yes — the inbox that receives messages |

The public contact form (`/contact`) delivers each message as an email from `EMAIL_FROM` to `CONTACT_FORM_TO`, with the sender's address as reply-to. It needs the email feature above. Without both, the form is shown disabled with an explanation, and submissions are refused on the server. Messages are not stored in the database and their content is never logged.

To test delivery without reaching a person, set `CONTACT_FORM_TO=delivered@resend.dev`.

## D. Billing (Stripe)

Dashboard: <https://dashboard.stripe.com/apikeys> — needed in the billing phase.

| Variable | Exposure | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | **server** | Prefer a **restricted key** (`rk_…`) with only the permissions billing needs (Customers, Checkout Sessions, Billing Portal, Subscriptions, Prices/Products read, Webhook endpoints read). |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | public | `pk_test_…` / `pk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | **server** | One per webhook endpoint / environment |

Rules enforced by validation: secret and publishable keys must be the same mode; **live keys are rejected outside production**; production with test keys produces a warning.

**Webhook:** Developers → Webhooks → *Add endpoint* `{APP_URL}/api/webhooks/stripe`, events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy the endpoint's signing secret.

**Local webhooks:** the Stripe CLI prints a `whsec_…` secret for the session; put it in `.env.local`:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

**Connectivity check:** `GET /v1/balance` (read-only).
**Rotation:** Developers → API keys → *Roll key* (Stripe can keep the old key valid for a grace period) → deploy → let the old key expire. Webhook secrets: roll on the endpoint page, deploy, then expire the old secret.

---

## E. Optional integrations

None of these are required for the core app. Status of each candidate:

| Integration | Status | Section |
|---|---|---|
| Customer credential encryption | **Required by all OAuth integrations** | [E1](#e1-customer-credential-encryption) |
| Google (Gmail, Calendar) | Selected for MVP | [E2](#e2-google-gmail-and-calendar) |
| Slack | Selected for MVP | [E3](#e3-slack) |
| HubSpot (CRM OAuth) | Selected for MVP | [E4](#e4-hubspot-crm) |
| Background execution (Trigger.dev) | Selected (ADR-004) | [E5](#e5-background-execution-triggerdev) |
| Error monitoring (Sentry) | Selected, optional | [E6](#e6-error-monitoring-sentry) |
| Scheduled-job authorization | Selected | [E7](#e7-scheduled-job-authorization) |
| Notion | **Not selected** — no variables defined | — |
| Telephony / voice agents | **Not selected** — post-MVP; provider decision pending | — |
| Embeddings (Voyage AI) | Selected (ADR-008) | [B2](#b2-embeddings-voyage-ai) |

OAuth scopes below are the **planned minimum** for the MVP tools in [integration-architecture.md](integration-architecture.md). Re-verify each against the provider's current documentation when the adapter is built, and request only what the tools use.

### E1. Customer credential encryption

Customer OAuth tokens and API keys are encrypted by the application with AES-256-GCM before they reach the database ([ADR-014](architecture-decisions.md)). The keys never live in the database.

| Variable | Exposure | Format |
|---|---|---|
| `INTEGRATION_ENCRYPTION_KEYS` | **server** | `keyId:base64Key[,keyId:base64Key…]`, each key exactly 32 bytes |
| `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID` | server | key id used for new encryptions |

**Generate** (prints a new entry; nothing is saved):

```bash
npm run env:generate-key
```

Then set `INTEGRATION_ENCRYPTION_KEYS=<printed entry>` and `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID=<its id>`. Use separate keys per environment.

**Backup and recovery requirements**
- Store every production key in **two** places outside Vercel: a password manager vault and an offline/secondary secret store, each with restricted access.
- Never delete a key from the keyring while any row still references it (the envelope records its key id; `credentials_key_id` column makes this queryable).
- **If a key is lost**, credentials encrypted with it cannot be recovered. The system reports `credential was encrypted with key "<id>", which is not in the keyring`; affected connections move to `needs_reauth` and customers must reconnect. No data other than those tokens is lost.

**Rotation** (scheduled yearly, or immediately on suspected exposure):
1. `npm run env:generate-key -- k2027a` → **prepend** the entry: `INTEGRATION_ENCRYPTION_KEYS=k2027a:<new>,k2026a:<old>`.
2. Set `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID=k2027a`, deploy to every runtime (Vercel and Trigger.dev) before step 3.
3. Re-encrypt: rows are rewritten with the active key on their next token refresh, and a re-encryption job (built with the integrations phase) rewrites the rest using `reencryptCredential()`.
4. When no row has `credentials_key_id = 'k2026a'`, remove the old entry and deploy. Keep the backup until its retention period ends.
5. On **suspected exposure**: do steps 1–4 immediately, *and* revoke/refresh customer tokens at the providers, since the attacker may already hold decrypted tokens.

### E2. Google (Gmail and Calendar)

Console: <https://console.cloud.google.com/>

| Variable | Exposure |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | server (not secret, but only the server needs it) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | **server** |

Steps:
1. Create a Google Cloud project per environment (e.g. `nexefiy-dev`, `nexefiy-prod`).
2. APIs & Services → Library → enable **Gmail API** and **Google Calendar API**.
3. OAuth consent screen (Google Auth Platform): External, app name, support email, authorized domain, privacy policy and terms URLs. While in *Testing*, add test users (up to 100).
4. Credentials → *Create OAuth client ID* → Web application → Authorized redirect URI `{APP_URL}/api/integrations/google/callback` (`http://localhost:3000/...` is allowed for development).
5. Copy the client id and secret.

Planned scopes: `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.compose`, `https://www.googleapis.com/auth/gmail.send`, `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/calendar.freebusy`. Request offline access to receive a refresh token.

**Verification warning:** Gmail read access (`gmail.readonly`) is a **restricted** scope. Before non-test users can connect, Google requires app verification *and* a third-party security assessment, which takes weeks. `gmail.send` alone is "sensitive" (verification without the assessment). Plan this early (see [known-limitations.md](known-limitations.md)).

**Connectivity check:** format only; verified by completing a real OAuth connection with a test user.
**Rotation:** Credentials → client → *Add secret* → deploy the new secret → delete the old one. Existing customer refresh tokens stay valid.

### E3. Slack

Dashboard: <https://api.slack.com/apps>

| Variable | Exposure |
|---|---|
| `SLACK_CLIENT_ID` | server |
| `SLACK_CLIENT_SECRET` | **server** |
| `SLACK_SIGNING_SECRET` | **server** — verifies every inbound Slack request |

Steps:
1. *Create New App* → From scratch (one app per environment; use a free development workspace for testing).
2. OAuth & Permissions → Redirect URLs: `{APP_URL}/api/integrations/slack/callback` (HTTPS only: use the Vercel preview URL or a tunnel locally).
3. OAuth & Permissions → **Bot Token Scopes**: `channels:read`, `chat:write` — exactly what the built actions use (`slack.channels.list`, `slack.messages.post`). No user scopes. (Reading channels and events — `channels:history`, `app_mentions:read` — arrive with Slack triggers.)
4. Optional: *Token Rotation* (OAuth & Permissions → Advanced). Supported: the app renews expiring tokens before use and stores each new refresh token. Without rotation, bot tokens don't expire.
5. Basic Information → App Credentials: copy client id, client secret and signing secret into `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` (the signing secret is required by the feature check; it will verify inbound events once those are built).
6. Enable distribution (Manage Distribution) before workspaces other than your own can install it. Apps distributed outside the Slack Marketplace get lower limits on `conversations.history`/`conversations.replies` (Slack changelog, 2025-05-29); the built actions don't use those methods.
7. To post, the app must be a member of the channel: in Slack, `/invite @your-app` in that channel (otherwise the action fails with "not in channel").

**Rotation:** Basic Information → *Regenerate* the client secret or signing secret → deploy immediately (the old value stops working on regeneration, so schedule a short window).

### E4. HubSpot (CRM)

Developer portal: <https://developers.hubspot.com/>

| Variable | Exposure |
|---|---|
| `HUBSPOT_CLIENT_ID` | server |
| `HUBSPOT_CLIENT_SECRET` | **server** — also verifies webhook signatures (v3) |

Steps:
1. Create a developer account and a **developer test account** (or a free HubSpot account) for development data.
2. Create an app with OAuth authentication (one per environment). On the current developer platform this is a project app whose `app-hsmeta.json` has `auth.type: "oauth"`; legacy public apps also work. Set the redirect URL to `{APP_URL}/api/integrations/hubspot/callback` (HTTPS; `http://localhost` is allowed for testing).
3. **Required scopes**: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write` — exactly what the built actions use (find contacts, create or update a contact, add a note to a contact; notes are written under the contacts scope). Add deal scopes only when deal actions are built.
4. Copy the client id and secret into `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`.
5. Webhooks (`contact.creation` → `{APP_URL}/api/webhooks/hubspot`) arrive with HubSpot triggers; not needed yet.

The connector calls the date-versioned APIs checked on 2026-10-18: OAuth `…/oauth/2026-03/token` (plus `/introspect` and `/revoke`) and CRM `…/crm/objects/2026-09/…`. Versions are constants at the top of `src/modules/integrations/connectors/hubspot.ts`.

**Rotation:** rotate the client secret in the app's Auth settings, deploy, and confirm webhook signature verification still passes.

### E5. Background execution (Trigger.dev)

Dashboard: <https://cloud.trigger.dev/>

| Variable | Exposure |
|---|---|
| `TRIGGER_SECRET_KEY` | **server** (`tr_dev_…`, `tr_prod_…`, per environment) |
| `TRIGGER_PROJECT_REF` | server (`proj_…`) |

Steps: create the project (EU region if offered), copy the project ref, copy the secret key of each environment from *API keys*, and add the variables the tasks need (e.g. `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, the encryption keyring) in the Trigger.dev dashboard — workers do **not** read Vercel's variables. Local development uses `npx trigger.dev@latest dev`.

**Rotation:** regenerate the environment's secret key in the dashboard, update Vercel, redeploy.

### E6. Error monitoring (Sentry)

| Variable | Exposure |
|---|---|
| `SENTRY_DSN` | server (a DSN is not a secret, but browser reporting is a separate decision) |

Create a Next.js project in Sentry, copy the DSN from Project Settings → Client Keys. Before enabling, configure Sentry's `beforeSend` to pass events through `redact()` and disable default PII collection.

### E7. Scheduled-job authorization

| Variable | Exposure |
|---|---|
| `CRON_SECRET` | **server**, ≥ 32 characters |

Generate with:

```bash
openssl rand -base64 32
```

When `CRON_SECRET` is set, Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on every scheduled invocation. Cron routes under `/api/cron/` must compare it in constant time and return 401 otherwise. **If `CRON_SECRET` is unset, cron routes reject every request** (fail closed). Manual runs must send the header themselves. Vercel does not retry failed cron runs; jobs must be idempotent and safe to re-run.

**Rotation:** set the new value in Vercel and redeploy; Vercel sends the current value on the next run.

---

## Safe connectivity checks

`npm run env:check:connectivity` runs these only for configured features. Each check sends a credential only to the provider that issued it, is read-only, has a 10-second timeout, and never prints response bodies.

| Feature | Check |
|---|---|
| Core | `GET {SUPABASE_URL}/auth/v1/settings` with the publishable key |
| Supabase privileged | `GET /auth/v1/admin/users?per_page=1` (body discarded) |
| AI (Anthropic) | Models API, list one model |
| Email | `GET /domains`; a sending-only key is reported as valid-but-restricted. `--send-test-email` sends one message to `delivered@resend.dev` |
| Billing | `GET https://api.stripe.com/v1/balance` |
| Encryption, cron | local validation only |
| Google, Slack, HubSpot, Trigger.dev, Sentry | format only — verified by a real OAuth connection / CLI / test event |

## Logging rules

Never log, store in task events, send to error monitoring, or include in model prompts:
- API keys, secret keys, client secrets, signing secrets, webhook secrets;
- `Authorization`, `Cookie`, provider signature headers;
- OAuth access, refresh, or id tokens, authorization codes, PKCE verifiers;
- raw webhook payloads (they can carry tokens and personal data) — log the provider, event id, and event type only;
- encrypted credential envelopes.

Pass anything that might contain them through `redact()` / `redactString()` from `src/lib/logging/redact.ts`, which removes sensitive keys and known credential shapes. Redaction is a safety net, not permission to log payloads.

## Leaked credential checklist

1. **Rotate** the credential at the provider immediately (sections above); for encryption keys follow E1 step 5.
2. Deploy the new value everywhere it's used (Vercel per environment, Trigger.dev, `.env.local`).
3. **Revoke** the old value.
4. If it was committed to Git: rotation is mandatory, since rewriting history doesn't remove clones and caches.
5. Review provider logs (Stripe events, Anthropic usage, Supabase logs) for use during the exposure window.
6. Record the incident in the audit log / incident notes.

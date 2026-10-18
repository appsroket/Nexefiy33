# Credential Inventory

Every external credential Nexefiy uses or may use, whether it has been selected, and when it's needed. Setup steps: [credential-setup.md](credential-setup.md). Variable details: [environment-variables.md](environment-variables.md). **No values belong in this file.**

Status: ✅ configured locally · ⬜ selected, not yet configured · ⏳ decision pending · ❌ not selected

| # | Provider | Credential(s) | Status | Exposure | Needed by | Disables when missing |
|---|---|---|---|---|---|---|
| A1 | Supabase | Project URL, publishable key | ✅ | public | app shell | the whole app (required) |
| A2 | Supabase | Secret key (`sb_secret_`) | ⬜ | server | first server job (webhooks, workers) | workers, webhooks, billing sync |
| A3 | Supabase | Legacy `service_role` JWT | ❌ not used (new key system) | server | — | — |
| A4 | Supabase | Database password / CLI login | ⬜ (migrations so far applied via the Supabase MCP connector) | CLI only | migrations (CLI) | running migrations |
| B1 | Anthropic | API key | ⬜ selected (ADR-015) | server | AI employees | AI employees, chat, NL workflow generation |
| B2 | OpenAI | API key | ❌ not selected (interface allows later) | server | — | — |
| B3 | Voyage AI | API key (`voyage-4`, 1024 dims) | ⬜ selected (ADR-008) | server | knowledge | knowledge indexing and semantic search |
| C1 | Resend | API key, sender address, verified domain | ⬜ selected (ADR-016) | server | app shell (invitation email) | invitation and notification email |
| D1 | Stripe | Secret/restricted key, publishable key, webhook secret | ⬜ | server + public | billing | subscriptions, checkout, portal |
| E1 | Nexefiy | Credential-encryption keyring | ⬜ | server | integrations | every OAuth integration |
| E2 | Google Cloud | OAuth client id/secret (Gmail, Calendar) | ⬜ selected | server | integrations | Gmail and Calendar connections |
| E3 | Slack | Client id/secret, signing secret | ⬜ selected | server | integrations | Slack connections and events |
| E4 | HubSpot | Public app client id/secret | ⬜ selected (CRM) | server | integrations | HubSpot connections |
| E5 | Trigger.dev | Secret key, project ref | ⬜ selected (ADR-004) | server | durable execution | durable runs, waits, schedules |
| E6 | Sentry | DSN | ⬜ optional | server | hardening | error reporting |
| E7 | Nexefiy | `CRON_SECRET` | ⬜ | server | durable execution | cron routes (fail closed) |
| — | Notion | Integration token / OAuth | ❌ not selected | — | — | — |
| — | Telephony / voice (e.g. Twilio + voice-agent platform) | Account credentials | ❌ post-MVP, provider pending | — | expansion | — |

## Handling rules

1. Use **test/sandbox** credentials outside production: Stripe test mode, Google test users, HubSpot developer test account, a Slack dev workspace, a Resend test subdomain. Live Stripe keys are rejected outside production by validation.
2. Each environment (development, preview, production) has its **own** credentials.
3. Customer credentials (OAuth tokens) are encrypted with AES-256-GCM before storage (ADR-014). They never reach the browser, logs, task events, or model prompts.
4. Prefer least privilege: Resend sending-access keys restricted to one domain, Stripe restricted keys, minimal OAuth scopes, per-environment Anthropic workspaces with spend limits.
5. Rotate immediately if a credential is pasted into chat, a commit, an issue, or a log — see the [leaked credential checklist](credential-setup.md#leaked-credential-checklist).

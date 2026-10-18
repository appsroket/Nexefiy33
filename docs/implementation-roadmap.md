# Implementation Roadmap

Each phase ends with a stop-and-report: files changed, tests executed, results, unresolved issues, next-phase prerequisites. Completed phases are numbered; upcoming phases are named (see below). Dependencies must not be violated.

## Dependency graph

```
P1 Foundation ✅
 └─ P2 Environment configuration & credentials ✅
     └─ P3 Database schema, RLS & security tests ✅
         └─ P4 Application shell ✅, P5 Public website ✅
             └─ P6 Auth & organizations ✅
                 ├─ CI & end-to-end tests
                 (Knowledge, AI employees and Tools below all need sign-in)
             ├─ P7 Knowledge ✅ (second migration pending)
             ├─ P8 Integration framework ✅ (HubSpot, Slack; live verification pending)
             ├─ AI employees & model gateway ─────┐
             │    (needs Knowledge for retrieval)  │
             └─ Tools, policy & approvals ◄───────┘
                  └─ Integrations (OAuth, encrypted credentials, adapters, webhooks)
                       └─ Durable execution (Trigger.dev) + task history
                            └─ Workflow editor (NL gen, visual, manual) + triggers
                                 ├─ Analytics & outcomes
                                 └─ Billing & entitlements (can start after App shell; enforcement needs Tools + Durable execution)
                                      └─ Hardening & launch
                                           └─ Expansion (voice employees, more templates/integrations)
```

Completed phases are numbered in the order the implementation prompts arrived. Upcoming phases are named, not numbered, so references stay stable if the prompt order changes.

## Completed

| Phase | Goal | Delivered | Verified by |
|---|---|---|---|
| **1** | Foundation & spec | `CLAUDE.md`, `docs/*`, env template, git remote | Owner review |
| **2** | Environment configuration & credentials | Credential inventory, `.env.example`, validated env module (`src/lib/env`), feature gating, credential encryption (AES-256-GCM keyring), log redaction, `npm run env:check`, setup guide | Vitest suite; Supabase connectivity check |
| **3** | Database schema, RLS & security tests | 12 migrations (33 tables, RLS + explicit grants everywhere, versioned JSON schemas, approval binding, audit log, RPCs), generated types, typed admin client, 173 pgTAP tests | pgTAP suite run against the dev project; Supabase advisors; Vitest static checks |
| **4** | Application shell | Next.js 16 + Tailwind/shadcn, `@supabase/ssr` clients and session proxy, responsive navigation, workspace switcher, account and notification menus, reusable tables/forms/dialogs/filters/states, error boundaries, read-only approvals list, real overview counts | `tsc`, ESLint, `next build`, bundle secret scan, Vitest. Not verified end to end while signed in (no auth yet) |
| **5** | Public website | Home, AI employees, use cases, integrations, security, pricing, getting started, contact (email delivery, feature-gated), sign-in/sign-up entry points, draft legal pages; built/planned status model; metadata, sitemap, robots; application moved to `/app` (ADR-020) | Vitest (links, honesty rules, metadata, contact handling), `next build`, bundle scan, browser check at 375 px and desktop |
| **6** | Auth & organizations | Sign-up/sign-in, email confirmation and password reset (Supabase Auth, PKCE callback and token-hash routes), sign-out here/everywhere, proxy route protection, workspace creation/switching/settings, company details, members (roles, removal), invitations (email via Resend or a shareable link; resend, revoke, accept), leave/delete workspace, profile, onboarding checklist; migration `invitation_lookup` (ADR-021) | pgTAP 005 (59) plus 001–003 re-run against the dev project; Vitest 276; `tsc`, ESLint, `next build`, bundle scan; signed-out browser checks. **Not exercised live with real accounts** (see known-limitations) |
| **7** | Knowledge & business context | Company profile, hours, brand voice; products, customers, goals/KPIs, departments, procedures, escalation contacts, templates, FAQs (`business_context_items`); private `knowledge` bucket with per-organization folders; upload of PDF/DOCX/text/Markdown/CSV/HTML; extraction, chunking, Postgres processing queue (leases, retries, reprocessing), optional Voyage embeddings, hybrid search with citations and an evidence verdict; untrusted-content framing (ADR-022); `/api/cron/knowledge` | Vitest 371, of which 95 new in `tests/knowledge` (extraction of real PDF/DOCX, chunking, evidence, worker, Voyage contract, retrieval, actions); `tsc`, ESLint, `next build`, bundle scan; migration `business_context` applied and checked live (validators, grants, advisors). **Pending:** `knowledge_pipeline` application, pgTAP 006 run, live Voyage call, signed-in browser check |
| **8** | Integration framework | Declarative connectors (provider, actions, Zod schemas, auth, scopes, risk, rate limits, timeouts/retries, idempotency, approval, error normalization); OAuth connect/callback with hashed single-use state; encrypted tokens with leased renewal; health checks; disconnect with provider revocation; executor with role/scope/policy checks, payload-bound approvals, idempotency keys, shared Postgres rate limits; HubSpot (find contacts, upsert contact, add note) and Slack (list channels, post message); integration pages, test console, approve/reject; `/api/cron/integrations`; migration `integration_framework` (ADR-023) | Vitest 474, of which 103 new in `tests/integrations` (domain rules, connector contracts from provider docs, executor, OAuth/credentials/health/disconnect, actions, callback route, approval decisions); `tsc`, ESLint, `next build`, bundle scan; migration applied to the dev project (MD5 match, grants checked, advisors); **pgTAP 007 34/34 against the dev project**. **Pending:** live HubSpot/Slack verification (container network blocks both APIs; app credentials not configured) |

## Upcoming (in dependency order)

| Phase | Goal | Key deliverables | Exit criteria | Prerequisites |
|---|---|---|---|---|
| **CI & end-to-end tests** | Every change checked automatically | GitHub Actions (typecheck, lint, Vitest, build, bundle scan, `supabase test db`), Playwright journeys for sign-up, invitations and two-workspace isolation against a test project | CI green on `main`; e2e journeys pass | Supabase CLI login + DB password as CI secrets, a test Supabase project or branch, test mailbox (or token-hash email templates) |
| **AI employees & model gateway** | Working employees | Templates, employee CRUD + versions UI, grants, `ModelGateway` + Anthropic adapter, chat (read-only tools) | Cited answer from Support employee; usage + cost recorded | `ANTHROPIC_API_KEY` |
| **Tools, policy & approvals** | Supervised actions | Tool registry + executor, policy engine, approval inbox (`decide_approval`), kill switches, limits | Tool-executor security suite passes; rejection prevents execution | AI employees |
| **More integrations** | Wider coverage | Gmail/Calendar, outbound webhooks, inbound webhook ingestion and triggers (Slack events, HubSpot webhooks), credential re-encryption job | Each adapter: contract tests + recorded live sandbox verification | Phase 8 live verification; Google OAuth verification for Gmail |
| **Durable execution** | Long-running runs | Trigger.dev setup, `employee.task`, approval waits, retries, idempotency, cancellation, run timelines, cron routes, approval-expiry & retention jobs | Run survives redeploy while waiting; idempotency test passes | Trigger.dev keys, `CRON_SECRET` |
| **Workflow editor** | Workflows | Definition schema (app side), semantic validation, NL generation, React Flow editor, manual forms, publish/versioning, triggers | MVP acceptance criteria #3–#5 | Durable execution |
| **Analytics** | Outcomes | Dashboard metrics, outcome events per template | Metrics match seeded data | Workflow editor |
| **Billing** | Revenue | Stripe products, Checkout, Portal, webhooks (`provider_webhook_events`), entitlements enforcement, usage metering | Quota block + upgrade restore e2e | Stripe test keys, pricing decision |
| **Hardening & launch** | Production readiness | Security headers, rate limits, Sentry, GDPR export/delete, legacy key disable, staging/production Supabase projects, Google OAuth verification | Security review done; MVP acceptance criteria 1–9 pass in staging | Domain, SMTP, legal docs |
| **Expansion** | Growth | Voice employees, more templates and integrations, agency mode | — | Telephony provider decision |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Prompt injection via inbound content leads to harmful external actions | High | Approval default for external writes; server-side authorization; injection evals; recipient allow-lists |
| Google restricted-scope verification delays Gmail launch | High (MVP integration) | Start verification early (Integrations phase); offer Outlook/IMAP alternative; limit to test users before verification |
| Durable engine lock-in / pricing | Medium | Keep orchestration logic in `modules/workflows`; Trigger.dev only in thin task wrappers (ADR-004) |
| LLM cost overruns | Medium | Tiered models, per-task/org limits, caching, metering |
| RLS mistakes | Critical | Helper functions, pgTAP suite per table, advisors after each migration |
| Toolchain churn (TypeScript 7, Next 16, Tailwind 4) | Medium | Pin versions; TypeScript 7 `tsc` with a TypeScript 6 alias for ESLint (ADR-019); verified with `next build` |
| No local Docker → slower DB testing | Low/Med | pgTAP runs against the dev project in rolled-back transactions; Docker-based `supabase test db` in CI |
| Scope creep across 11 employee categories | High | Shared runtime; ship 3 templates first; others are config |

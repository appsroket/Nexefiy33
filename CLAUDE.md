# CLAUDE.md — Nexefiy

Permanent instructions for Claude Code (and humans) working in this repository. Keep this file current at the end of every phase.

## What Nexefiy is

Nexefiy is a multi-tenant SaaS "AI workforce" platform. A business creates an organization, configures AI employees (support, sales, marketing, operations, executive assistant, analytics, finance admin, HR admin, research, voice, custom), connects its business apps, assigns work, coordinates employees through workflows, supervises execution through approvals, and measures outcomes.

All employee categories run on **one shared employee runtime**. A "sales employee" is configuration (role, instructions, skills, tools, policies), not a separate product or code path.

Start with [docs/product-vision.md](docs/product-vision.md) and [docs/system-architecture.md](docs/system-architecture.md).

## Current status

- **Phase:** 8 — Integration framework (built, pending review; live HubSpot/Slack verification outstanding). Phases 1–7 complete (7's `knowledge_pipeline` migration still awaits application).
- **Code:** Next.js app with the public website at `/` (`src/app/(site)`, `src/modules/marketing`), account pages (`/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`, `/invite`) and email-link routes (`src/app/auth`) from `src/modules/identity`, and the signed-in application under `/app` (`src/app/app`, `src/modules/app-shell`, `src/modules/identity`, `src/modules/governance`, `src/modules/knowledge`, `src/modules/integrations`), the OAuth callback (`src/app/api/integrations/[provider]/callback`), cron routes (`src/app/api/cron/knowledge`, `src/app/api/cron/integrations`); shared UI in `src/components`; `src/lib` (env, crypto, logging, email, Supabase clients, forms, rate limit, list params, status labels); `supabase/migrations` (15 applied, 1 pending), `supabase/tests` (pgTAP), `scripts/`, Vitest tests.
- **Built in Phase 6, not yet exercised live:** sign-up/sign-in/sign-out, email confirmation, password reset/change, workspaces, members, invitations, profile, onboarding checklist (ADR-021). Verified by pgTAP, Vitest with a fake Supabase client, the build, and signed-out browser checks only — no real account has signed in. Say so until it has.
- **Built in Phase 7, not yet exercised live:** business context (company profile, hours, brand voice, products, customers, goals/KPIs, departments, procedures, escalation contacts, templates, FAQs), document upload (PDF, DOCX, text, Markdown, CSV, HTML), extraction, chunking, the Postgres processing queue with retries, hybrid keyword/vector retrieval with citations and an evidence verdict (ADR-022). Migration `business_context` is applied; `knowledge_pipeline` (storage bucket, queue, search) has pgTAP tests (006) but is **not applied and those tests have not run** — its DROP statements need the owner's confirmation in the Supabase connector. Voyage embeddings are contract-tested only.
- **Built in Phase 8, not yet exercised live:** declarative connector framework (`src/modules/integrations/connectors`: provider, actions, Zod schemas, auth, scopes, risk, rate limits, timeouts/retries, idempotency, approval, error normalization), OAuth connect/callback, encrypted tokens with leased renewal, health checks, disconnect with provider revocation, one executor with payload-bound approvals, and two connectors: **HubSpot** (find contacts, create/update contact, add note) and **Slack** (list channels, post message) (ADR-023). Migration `integration_framework` is applied; pgTAP 007 passed 34/34 against the dev project. **No live HubSpot or Slack call has been made** (this container's network blocks both APIs; no app credentials configured): connectors are contract-tested from provider documentation only. Follow docs/integration-architecture.md §7 before calling either available; the website keeps them `first_release`.
- **Integration rules:** every action goes through `requestAction`/`runExecution` (`src/modules/integrations/server/executor.ts`) — never call a connector's `execute` directly. Connectors declare; the executor authorizes. Organization and role come from the verified session or task. Tokens are only touched by `server/credentials.ts`; never select or log `integration_secrets` or `tool_executions.pending_input` elsewhere. New actions: declare risk, approval (`default_required` for external writes), idempotency honestly (`not_idempotent` unless the provider deduplicates), scopes, and add contract tests.
- **Knowledge rules:** documents, emails and web content are untrusted data. Retrieved text reaches a model only through `formatEvidenceForModel` (delimited, with the "not instructions" preamble); never let a passage choose tools, recipients or organizations. The organization for retrieval always comes from the verified workspace or task, never from model output. Service-role knowledge code filters by `organization_id` on every query (tests assert it).
- **Not built:** AI employees, inbound integration webhooks/triggers, Gmail/Calendar, workflows, durable workers (Trigger.dev), billing, CI, Playwright. Do not claim otherwise.
- **Auth rules:** Server Actions that change data call `getVerifiedUser()` (Supabase `getUser`); rendering uses `getClaims`. Redirect targets go through `safeNextPath`. Never log emails, passwords, invitation tokens or auth codes. Identity Zod schemas live in `src/modules/identity/domain/schemas.ts` and form parsing in `src/lib/forms/parse-form.ts`; keep Zod out of modules client components import (a test enforces this).
- **Website honesty:** every capability shown publicly lives in `src/modules/marketing/domain` with a status (`built` / `first_release` / `later`). Move an item to `built` only in the change that ships and tests it, and add its evidence to `tests/app/site-content.test.ts`. Never add testimonials, customer logos, customer or integration counts, prices, or outcome figures.
- **Supabase:** project `rnqrqconfbcrmszllxgu` (eu-north-1, Postgres 17) is the **development** database (ADR-010): RLS everywhere, no application data (36 tables after Phase 8). Staging/production projects do not exist yet.
- **Next phase:** live HubSpot/Slack verification (credentials + network access, §7 checklist); apply `knowledge_pipeline` and run pgTAP 006; then CI & end-to-end tests or AI employees. See [docs/implementation-roadmap.md](docs/implementation-roadmap.md).

## Stack (verified versions in docs/architecture-decisions.md, ADR-002)

Next.js App Router · React · strict TypeScript · Tailwind CSS + shadcn/ui · Supabase Auth/Postgres/Storage with RLS · Zod · provider-independent model interface (Anthropic first, ADR-015) · Resend email (ADR-016) · Trigger.dev for durable execution · React Flow (`@xyflow/react`) · Stripe · Vercel.

## Configuration and secrets

- Read configuration only through `src/lib/env`: `getServerEnv()` / `requireFeature('<feature>')` from `@/lib/env/server` on the server, `getPublicEnv()` from `@/lib/env/public` in client code. Never read `process.env` directly elsewhere.
- Only the core Supabase values (and the app URL in production) are required. Every other credential gates one feature: call `requireFeature()` at the point of use so a missing optional credential disables only that feature.
- New variables: add them to `src/lib/env/catalog.ts`, `core.ts`, `.env.example`, and the docs (see docs/environment-variables.md → "Adding a variable").
- Customer integration credentials are stored only as `encryptCredential()` envelopes (ADR-014).
- Never log keys, auth headers, tokens, codes, or raw webhook payloads; pass anything that might contain them through `redact()` from `@/lib/logging/redact`.
- Test fixtures build fake credentials at runtime (`tests/helpers/env-fixtures.ts`) — never commit realistic-looking keys.

## Database

- Schema changes only through new files in `supabase/migrations/` (never edit an applied migration). After each migration: run the pgTAP suite, check Supabase advisors, regenerate types (`npm run db:types`), and update docs/database-design.md.
- Roles: owner > admin > operator > viewer. Permission matrix: docs/database-design.md §3.
- Clients never write execution state, credentials, billing, or published workflow versions; the server does, after validation.
- JSON configuration is validated by versioned schemas (`private.*_is_valid`) and must never contain credentials.

## Repository layout (target; modules other than marketing, app-shell, identity, governance, knowledge and integrations arrive in later phases)

```
src/
  app/                      Next.js routes (UI + route handlers). Thin: delegate to modules.
    (site)/                 Public website and account pages at "/".
    app/                    Signed-in application under "/app".
    auth/                   Email-link routes (/auth/callback, /auth/confirm).
  components/               Shared UI (components/ui = shadcn/ui primitives).
  modules/<module>/
    domain/                 Pure types, Zod schemas, business rules. No I/O.
    server/                 Server-only services and repositories ("server-only" import).
    ui/                     React components for this module.
  lib/                      Cross-cutting utilities (supabase clients, env, logging).
supabase/migrations/        Versioned SQL migrations — the only way to change the schema.
supabase/tests/database/    pgTAP security tests (each file self-contained, rolled back).
supabase/test-fixtures/     Shared pgTAP fixtures, copied into test files by npm run db:test:sync.
trigger/                    Trigger.dev task definitions (durable execution).
tests/                      Vitest unit/integration tests and Playwright e2e.
docs/                       Specification and decisions.
```

Modules: `marketing` (public website), `app-shell`, `identity` (auth + orgs), `knowledge`, `integrations` (connectors, OAuth, executor), `employees`, `models`, `skills` (typed tools), `workflows`, `governance` (approvals + policy), `observability` (tasks + audit), `analytics`, `billing`. A module may import another module's `domain` exports and public `server` service functions only — never its internals or tables directly.

## Permanent engineering rules

1. **Never fabricate.** Do not claim an integration, feature, or test works unless it was actually executed and observed. Mocked or contract-tested adapters must be labelled as such. Report failing tests verbatim.
2. **Model output is never authorization.** Every tool call proposed by a model is re-checked server-side against the caller's organization, the employee's granted tools, entitlements, and policy. The model cannot grant itself permissions, choose another org, or skip approvals.
3. **No privileged credentials in browser code.** Only `NEXT_PUBLIC_*` variables reach the client, and only the Supabase URL, Supabase publishable key, Stripe publishable key, and app URL may be `NEXT_PUBLIC_`. Server modules import `server-only`.
4. **No cross-organization access.** Every tenant-owned table has `organization_id`, `UNIQUE (id, organization_id)`, composite foreign keys to its parents, RLS enabled, explicit grants, and policies using `private.member_org_ids()` / `private.org_ids_with_min_role()`. Service-role code (`getAdminClient()`) must scope every query by `organization_id` explicitly. New tables follow docs/database-design.md §1 and get pgTAP isolation tests.
5. **Persist long-running state.** Anything that waits (approvals, retries, multi-step runs, scheduled work) runs in the durable engine with state in Postgres — never in an in-memory promise or a serverless request.
6. **Validate AI-generated workflows** with Zod schema validation *and* semantic validation (tools exist, are granted, integrations connected, graph acyclic where required, policies satisfiable) before saving a draft, and again before publishing.
7. **Restricted actions require approval.** Tool risk levels and org policies determine `auto` / `require_approval` / `deny`; default for external writes is `require_approval`.
8. **Audit without hoarding.** Write append-only audit events for security-relevant actions. Store references and redacted summaries, not raw secrets, tokens, or full message bodies unless the feature needs them.
9. **Versioned SQL migrations only** (`supabase/migrations/<timestamp>_<name>.sql`). No dashboard schema edits. No destructive migration without an explicit, reviewed plan.
10. **Test security boundaries,** not just happy paths: cross-org reads/writes, role escalation, unauthenticated access, approval bypass, webhook signature failures.
11. **Stop at each phase boundary** and report: files changed, tests executed, results, unresolved issues, next-phase prerequisites.
12. **Explain before destroying.** If a major architectural conflict appears, describe it and wait for direction before deleting or rewriting working code.
13. **Secrets live in `.env.local` (git-ignored) or a secret manager** — never in source, docs, prompts, or commit messages. `.env.example` holds placeholders only.

## Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | Vitest suite |
| `npm run env:check` | Which features are configured; prints no secrets. `--strict` exits 1 on misconfiguration |
| `npm run env:check:connectivity` | Plus read-only provider checks (Supabase, Anthropic, Resend, Stripe) |
| `npm run env:generate-key` | New entry for the credential-encryption keyring |

| `npm run db:test:sync` | Copy `supabase/test-fixtures/*.sql` into the pgTAP test files |
| `npm run db:types` | Regenerate `src/lib/supabase/database.types.ts` from the linked project |
| `npx supabase migration list --linked` | Compare local and applied migrations |
| `npx supabase db push --linked --dry-run` | Preview pending migrations (then run without `--dry-run`) |
| `npx supabase test db --linked` | Run the pgTAP security suite (requires `supabase login` + `link`) |

| `npm run dev` | Next.js dev server on http://localhost:3000 (website at `/`, application at `/app`) |
| `npm run build` | Production build (`next build` does not lint; run `npm run lint` too) |
| `npm run lint` | ESLint (flat config; bans `process.env` outside `src/lib/env`) |
| `npm run check:bundle` | After a build: scans browser assets for secrets and server-only variable names |

Planned: `test:e2e` (Playwright). Database workflow details: docs/supabase-setup.md.

## Environment

- No Docker on the primary dev machine → no local Supabase stack. RLS/pgTAP tests run against a Supabase branch or a dedicated dev project (see [docs/testing-strategy.md](docs/testing-strategy.md)).
- Supabase CLI is available via `npx supabase`.
- Node 24. TypeScript runs side by side (ADR-019): `tsc` is TypeScript 7.0.2 (`@typescript/native`), while the `typescript` package name is aliased to TypeScript 6.0 for tools that need the JS API (typescript-eslint). Verified with `tsc`, ESLint, `next build`, and Vitest.
- Dependencies are pinned to exact versions, choosing the newest release that is at least about a week old (ADR-019).
- Rendering: Cache Components are off; `/app` routes are dynamic and the public website is static (ADR-018, ADR-020).
- GitHub remote: `https://github.com/appsroket/Nexefiy.git` (private), default branch `main`.

## Documentation map

| Topic | File |
|---|---|
| Vision / requirements / MVP | docs/product-vision.md, docs/product-requirements.md, docs/mvp-scope.md |
| Architecture | docs/system-architecture.md, docs/architecture-decisions.md |
| Data | docs/database-design.md (schema, roles, RLS), docs/supabase-setup.md (operations) |
| Employees and orchestration | docs/ai-employee-architecture.md, docs/agent-orchestration.md |
| Integrations | docs/integration-architecture.md |
| Credentials | docs/api-credentials.md (inventory), docs/credential-setup.md (setup, redirect URIs, webhooks, scopes, rotation) |
| Security | docs/security-and-governance.md |
| Workflows | docs/workflow-editor.md |
| Billing | docs/billing-and-entitlements.md |
| Config | docs/environment-variables.md |
| Quality | docs/testing-strategy.md |
| Plan and gaps | docs/implementation-roadmap.md, docs/known-limitations.md |

# Testing Strategy

Principle: **security boundaries are tested as rigorously as features.** A phase is not done until its boundary tests pass, and results are reported verbatim.

## 1. Test layers

| Layer | Tool | Scope | Runs |
|---|---|---|---|
| Static | TypeScript strict, ESLint, import-boundary lint rule | Types, module boundaries, no `NEXT_PUBLIC_` secrets | every commit (CI) |
| Unit | Vitest | Domain logic: Zod schemas, policy engine, workflow validation, reference resolver, cost accounting | every commit |
| Database | pgTAP (`supabase test db`) | RLS policies, RPCs, triggers (last-owner guard, append-only audit) | every PR touching migrations |
| Integration | Vitest + real Supabase test project/branch | Module services against a real database with seeded orgs/users | every PR |
| Adapter contract | Vitest + recorded fixtures (msw) | Adapter request/response mapping, error normalization, redaction | every PR — labelled "contract (fixture)" |
| Adapter live | Manual or scheduled job against sandbox accounts | Real provider calls | before marking an integration available; nightly (P1) |
| Durable execution | Trigger.dev dev environment | Waits/resume, retries, idempotency, cancellation | per phase 7+ |
| End-to-end | Playwright | Critical user journeys and cross-org isolation through the UI | PRs to main |
| Model behaviour | Eval suite (fixtures + rubric/assertions) | NL→workflow generation validity, tool-use correctness, injection resistance | on prompt/model changes |

## 2. Mandatory security test suites

**Tenant isolation (pgTAP + integration):** for every tenant table, as user A (org A): select/insert/update/delete rows of org B → 0 rows / error. Includes RPCs and storage objects.

**Role boundaries:** `viewer` and `operator` cannot manage members, integrations, policies, billing; cannot approve actions above their role; cannot remove the last owner.

**Unauthenticated:** anon key cannot read any tenant table.

**Tool executor:** ungranted tool → denied; tool targeting connection of another org → denied; model-supplied `organizationId` ignored; `write_external` without approval → waits; rejected approval → no adapter call (assert mock not called); double execution with same idempotency key → one external effect.

**Webhooks:** bad signature → 401 and no row; replayed event id → processed once.

**Prompt injection evals:** inbound content with instructions to exfiltrate data or change recipients must not produce an allowed external write.

**Secrets:** CI scans `.next/static` for secret prefixes.

## 3. Environments

No Docker on the primary dev machine, so the Supabase local stack is unavailable there (ADR-010):
- Database tests run against the **development project** (`rnqrqconfbcrmszllxgu`) with `npx supabase test db --linked`. Every test file runs in a transaction that is rolled back, so no data persists.
- CI (GitHub Actions, Linux) can run `supabase start` + `supabase test db` with Docker for isolated databases per run (not set up yet).
- **Local PostgreSQL (Phase 11):** `npm run db:test:local` starts a throwaway PostgreSQL 16+ cluster, applies every migration on top of a small Supabase stand-in (`supabase/local/`: the API roles with Supabase's default privileges, `auth.users`/`auth.uid()`, `storage.buckets`/`objects` with the delete guard, and `pg_jsonschema` backed by Python's `jsonschema`), runs the pgTAP suite with `pg_prove`, then the database integration tests in `tests/integration` (`vitest.integration.config.ts`). Integration tests run the real runner, executor, dispatcher, Server Actions and queries against the database through `tests/helpers/pg-supabase.ts`, a Supabase-client adapter over `pg` that runs each request as `service_role` or as an authenticated user (so RLS, grants, constraints and triggers all apply). Needs `postgresql-16`, `-pgvector`, `-pgtap`, `postgresql-plpython3-16`, `python3-jsonschema` and `pg_prove`. It is evidence about our SQL and code, not about the hosted platform (PostgreSQL 16 locally vs 17 on Supabase; pgvector 0.6 locally ignores one 0.8-only setting, reported by the script). Phase 12 added pgTAP 011 (workflow graph v2, drafts, activation, runs, the orchestrator's lease, approval gates, cancellation, schedules) and `tests/integration/workflows.test.ts` (generation → draft, refusals before activation, hand-off policy, end-to-end runs with an employee step, a gate and an approved HubSpot write, branches, joins, delays, failure paths, cancellation, lost authority, a scheduled start). The adapter sends `json`/`jsonb` RPC arguments as JSON (arrays included), like PostgREST.
- **Templates and skills (Phase 13):** `tests/employees/templates.test.ts` checks that built capabilities match the tool catalog, skills use real tools and match the rows migration `employee_skills_catalog` seeds (parsed from the SQL), shipped procedures keep their fingerprints, procedures reach the prompt only when available, every template declares what it must, availability is computed (voice refused by the domain and the Server Action), drafts pass the shared schema and validation, and no usable template advertises an unbuilt integration. pgTAP 012 covers the seeded catalog and reserved keys. The gallery was rendered in Chromium from `templateCards` (desktop and 390 px wide); the harness is not committed.
- **Governance (Phase 14):** pgTAP 013 calls every governance function and table directly as each role, the service role and another workspace (policy versions and authorization stamps, approval integrity, separate approvers, expiry, allowlists, revocation incl. deferred re-grants, handoff, employee and workspace emergency stop incl. claims and triggers, retention purge and hold, audit visibility and immutability). `tests/integration/governance.test.ts` runs the real runner, executor and SQL with a scripted model and fake HubSpot: the employee can't approve its own action (no tool; service-role update refused), separate approver enforced, approvals voided when the account, the approver's role or policy changes, only an authorized policy waives approval, revocation cancels and blocks, the emergency stop halts mid-task and lifting resumes it, blocked knowledge never reaches the model, workspace budget stops tasks, handoff is final; and checks the audit entries. `tests/governance/*` cover the policy engine, risk catalog, schemas, Server Actions and static guarantees (only `approval-actions.ts` calls `decide_approval`; no employee tool touches approvals or governance).
- **Editor in a browser (Phase 12):** the workflow editor and run viewer were mounted in a standalone page (esbuild bundle, Tailwind compiled with PostCSS, server actions and router stubbed) and driven with Playwright/Chromium: steps and connections render, selecting, renaming, adding, undo/redo, saving, step forms, JSON refusal of unknown step types, and read-only statuses. The harness is not committed; signed-in checks on a real deployment remain to do.

## 4. Database security suite (implemented in Phase 3)

| File | Covers | Tests |
|---|---|---|
| `supabase/tests/database/001_schema_security.test.sql` | RLS on every table, policy coverage, no anon access, no client access to credentials/webhooks, read-only execution/billing tables, every function pins `search_path`, exact RPC surface, `timestamptz`, vector dimension, no float money | 18 |
| `002_tenant_isolation.test.sql` | Anonymous and outsider access, org A vs org B reads/updates/deletes/inserts across all 27 tenant tables, composite-FK cross-tenant references, knowledge search, approvals, invitations | 40 |
| `003_roles_and_membership.test.sql` | Viewer/operator/admin/owner privileges, membership administration rules, revocation and removal, last-owner protection, invitation acceptance | 60 |
| `005_auth_workspace_flow.test.sql` | Creating workspaces, invitation lookup by token, duplicate and lapsed invitations, revoked and expired invitations, removed members rejoining, role changes taking effect at once, profiles, leaving, owner-only deletion with cascade and audit record, attempts on another organization | 59 |
| `004_credentials_and_integrity.test.sql` | Credentials unreadable by members and encrypted-only, secret scanning of config, JSON schemas, statuses and lifecycle checks, idempotency, immutability, task-dependency cycles, approval binding to payload fingerprint, expiry, audit log append-only | 55 |

Shared fixture: `supabase/test-fixtures/two_organizations.sql` (two organizations, one user per role, one row in every tenant table), copied into each file by `npm run db:test:sync`; `npm test` fails if a copy drifts.

Static checks in `tests/db/migrations.test.ts` (run by `npm test`, no database needed): migration naming, RLS + revoke for every created table, pinned `search_path` on every function, generated types cover every table, embedding dimension matches config.

## 5. Test data

Fixtures create users and organizations with fixed UUIDs inside the test transaction. Never real customer data. Fixture credentials are fake strings that cannot authenticate anywhere (built at runtime in Vitest fixtures so secret scanners stay quiet).

## 5a. Application and website checks (Phases 4–6)

| Check | Where | What it proves |
|---|---|---|
| Shell logic | `tests/app/shell-logic.test.ts` | Navigation matching, workspace selection ignores a tampered cookie, list parameters are whitelisted |
| Website content | `tests/app/site-content.test.ts` | Every public page exists and is listed; every internal link, anchor and `?topic=` resolves; no testimonials, logos, counts, prices or outcome figures; every "Built" claim has evidence in the repository; legal drafts are noindex; sitemap and robots per environment |
| Contact form | `tests/app/contact.test.ts` | Refuses when not configured; honeypot; rate limit; validation (including header-safe single-line fields); one plain-text email with reply-to; failures logged without message content, address or key |
| Identity rules | `tests/app/identity-domain.test.ts` | Safe redirects (open-redirect attempts), proxy routing, password byte limit, workspace address rules, member permissions mirroring the database, invitation link keeps the token in the fragment, header-safe invitation email, onboarding progress, no Zod in client-imported modules |
| Identity actions | `tests/app/identity-actions.test.ts` | With a fake Supabase client: validation before any call, safe redirects, rate limit, no emails/passwords/tokens/codes in logs, ended sessions refused, zero-row changes treated as not allowed, database refusals explained, removal revokes, invitation link only when email isn't configured, email-link routes |
| Bundle secrets | `npm run build && npm run check:bundle` | No secret values, credential patterns or server-only variable names in browser assets |
| Browser (manual) | dev server | Every public route at 375 px: one `<h1>`, no horizontal scroll, skip-link target; mobile menu focus and Escape; contact form disabled state and server refusal |

Not automated yet: Playwright journeys (sign-up, invitations, two-workspace isolation through the UI), axe accessibility scans, and visual checks of the signed-in pages.

## 6. Definition of done (every phase)

- Typecheck, lint, unit, database, integration tests pass (output included in the phase report).
- New tables have RLS + isolation tests.
- Supabase advisors show no new security warnings.
- Docs and `CLAUDE.md` updated; known limitations listed honestly.

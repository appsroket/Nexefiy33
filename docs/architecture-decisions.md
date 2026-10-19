# Architecture Decision Records

Status values: **Accepted**, **Proposed** (needs owner/phase confirmation), **Superseded**.

---

## ADR-001 Modular monolith first — Accepted

**Context:** Twelve functional modules, small team, early product.
**Decision:** One Next.js application with strict module folders and service APIs; durable workers via Trigger.dev from the same repo. No microservices until a module has a concrete scaling or isolation need.
**Consequences:** Simple deploys and refactors; boundaries must be enforced by lint rules and review.

## ADR-002 Technology versions — Proposed (verify each package when the app-shell phase installs it)

Latest npm versions observed on 2026-10-17:

| Package | Version | Note |
|---|---|---|
| next | 16.4.2 | App Router; requires Node ≥ 20.9 (local Node 24.20 ✅) |
| react | 19.3.1 | |
| typescript | 7.0.2 | Native (Go) compiler. Installed in Phase 2: `tsc --noEmit` and Vitest work. **Still verify** with Next.js and ESLint in the app-shell phase; fall back to 6.x if anything breaks. |
| @anthropic-ai/sdk | 0.135.0 | Installed in Phase 2 (env connectivity check); model adapter in the AI-employees phase |
| tsx | 4.23.15 | Runs TypeScript scripts (`npm run env:check`) |
| tailwindcss | 4.3.3 | |
| shadcn (CLI) | 4.22.0 | |
| @supabase/supabase-js | 2.118.0 | |
| @supabase/ssr | 0.12.7 | |
| supabase (CLI) | 2.121.0 | |
| zod | 4.6.7 | |
| @trigger.dev/sdk | 4.7.4 | Installed in Phase 11 as **4.7.3** (the newest release at least a week old, ADR-019); `ws` overridden to 8.21.3 to clear the SDK's transitive `ws` advisories. The `trigger.dev` CLI is run with `npx trigger.dev@4.7.3`, not installed (its dependencies carry `tar`/`ws` advisories). |
| @xyflow/react | 12.12.0 | React Flow |
| stripe | 23.0.0 | |
| vitest | 5.0.5 | |
| @playwright/test | 1.64.1 | |
| eslint | 10.13.0 | |

**Decision:** Use these majors, pin exact versions in `package.json`, read each package's current docs before use.
**Installed (Phase 4):** see ADR-019 for the versions actually pinned and the TypeScript 6/7 arrangement.

## ADR-003 Supabase as data, auth, storage, and secrets platform — Accepted

Postgres with RLS for tenant isolation, Supabase Auth with `@supabase/ssr`, Storage for documents, pgvector for embeddings. (Integration tokens: see ADR-014.) Use the new `sb_publishable_` / `sb_secret_` keys; legacy JWT keys to be disabled before launch.

## ADR-004 Trigger.dev for durable execution — Accepted (Phase 11; see ADR-026 for how it is used)

**Context:** Runs wait hours/days for approvals and must survive deploys and serverless timeouts.
**Options:** Trigger.dev v4 (TypeScript-native, waitpoint tokens, concurrency keys, schedules, cloud + self-host), Inngest (similar, step functions), Temporal (most powerful, heavier ops), Postgres queue (`pgmq`) + custom workers (most control, most work).
**Decision:** Trigger.dev v4, with orchestration logic in `modules/workflows` and Trigger.dev confined to thin task wrappers so it is replaceable. Confirm pricing/region in the durable-execution phase.

## ADR-005 Postgres as the source of truth for run state — Accepted

Trigger.dev executes; Postgres records. UI, analytics, audit, and resumption logic read Postgres, not the engine's API.

## ADR-006 Explicit workflow graphs over free-form multi-agent chat — Accepted

Orchestration via versioned graphs with typed node outputs; bounded delegation tool for handoffs. Predictable cost, auditable, testable.

## ADR-007 Provider-independent model gateway — Accepted

Own thin `ModelProvider` interface; first adapter uses the official Anthropic SDK. Model tiers (`fast`/`balanced`/`deep`) map to concrete models in config. Using the Vercel AI SDK (`ai` 7.x) as an adapter implementation detail is allowed but not as the public interface, to keep tool-call handling and cost accounting under our control.

## ADR-008 Embeddings: Voyage AI `voyage-4`, 1024 dimensions — Accepted (Phase 3)

**Context:** Anthropic has no first-party embeddings API. Options were Voyage AI, OpenAI `text-embedding-3-*`, and Supabase `gte-small` (384-d, Edge Functions). The schema needs a fixed vector dimension.
**Decision:** Voyage AI `voyage-4` (current Voyage generation, verified 2026-10-17 in Voyage's docs: default output 1024, also 256/512/2048) at **1024 dimensions**, cosine distance, HNSW index (pgvector 0.8). Constants in `src/lib/config/embeddings.ts`; credential `VOYAGE_API_KEY`.
**Consequences:** every chunk stores `embedding_model`; changing model or dimension needs a migration and re-embedding (vectors across models — including Voyage 3.x vs 4.x — are not comparable). 1024 balances retrieval quality, storage (4 KB per vector), and index speed.

## ADR-009 Tool definitions in code, grants in the database — Accepted

Typed Zod schemas and risk levels are code (type-checked, reviewed, versioned). Which org/employee may use which tool is data (auditable, revocable).

## ADR-010 Database environments — Accepted (Phase 3, owner decision 2026-10-17)

**Decision:** `rnqrqconfbcrmszllxgu` (empty at the time) is the **development** database; migrations are applied and pgTAP tests run against it inside rolled-back transactions. Separate staging and production projects are created before launch. CI can run `supabase start` in Docker for isolated test databases.
**Consequences:** never run `db reset` against the linked project; production promotion follows the checklist in supabase-setup.md.

## ADR-011 Integration credential storage in Supabase Vault — Superseded by ADR-014

OAuth tokens stored via `vault.create_secret`, accessed only by server code with the secret key through a `private` security-definer function scoped by org. `INTEGRATION_ENCRYPTION_KEY` exists only as a fallback if Vault is unsuitable for some credential type.

## ADR-012 Approval-by-default for external writes — Accepted

`write_external` and `sensitive` tools require human approval unless an org admin explicitly grants autonomy for a specific tool and condition. `sensitive` cannot be made autonomous in the MVP.

## ADR-013 Deployment on Vercel — Proposed

Web app on Vercel (EU region near Supabase), workers on Trigger.dev Cloud. Voice runtime (later) will need a long-lived-connection host and is out of scope here.

## ADR-014 Application-level authenticated encryption for customer credentials — Accepted (Phase 2)

**Context:** Customers' OAuth access/refresh tokens and API keys must be stored so Nexefiy can act on their behalf. ADR-011 proposed Supabase Vault. Vault decrypts inside the database for any role allowed to read `vault.decrypted_secrets`, so anyone holding database-level access (a leaked secret key, a SQL injection in a privileged function, a database dump) can also read every customer token.
**Decision:** Encrypt in the application with AES-256-GCM (`src/lib/crypto/credential-encryption.ts`):
- Keys live outside the database in `INTEGRATION_ENCRYPTION_KEYS` (a versioned keyring) with `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID` selecting the key for new writes.
- Each ciphertext is a self-describing envelope `nxf1.<keyId>.<iv>.<ciphertext>.<tag>`, stored in `integration_connections.encrypted_credentials`.
- Additional authenticated data binds the ciphertext to `organization_id`, `connection_id`, and purpose, so a ciphertext moved to another row or tenant fails authentication.
- Rotation is incremental: add a key, make it active, re-encrypt rows lazily or with a job, retire the old key once no row references it.
**Consequences:** Database compromise alone does not expose customer tokens; the keyring becomes a critical secret that must be backed up (losing it forces every customer to reconnect). Workers that decrypt need both `SUPABASE_SECRET_KEY` and the keyring. Supersedes ADR-011.

## ADR-015 Anthropic as the initial AI model provider — Accepted (Phase 2)

**Context:** One provider is implemented first; others plug into the `ModelProvider` interface (ADR-007).
**Verified 2026-10-17** (Anthropic API reference bundled with Claude Code, cached 2026-10-06):
- Models: `claude-opus-5-5` ($4 / $20 per million input/output tokens, 1M context), `claude-sonnet-5-5` ($2 / $10), `claude-haiku-5-5` ($0.10 / $0.50 for prompts up to 100K tokens).
- Tool calling with `strict: true` schema enforcement; structured outputs via `output_config.format` / `messages.parse()`; streaming; prompt caching; Models API for live capability lookup.
- Notes for the adapter (AI-employees phase): forced `tool_choice` (`any`/`tool`) is rejected on Opus 5.5 / Sonnet 5.5 — use `auto` + `strict` tools or structured outputs; thinking cannot be disabled on Opus 5.5 (tune `effort`, default `medium`); handle `stop_reason: "refusal"`.
**Decision:** `AI_PROVIDER=anthropic` (default) with the official `@anthropic-ai/sdk`. Default model `claude-opus-5-5`; tier mapping (`deep`/`balanced`/`fast` → Opus 5.5 / Sonnet 5.5 / Haiku 5.5) stays configuration, confirmed against cost data in the AI-employees phase. Only `ANTHROPIC_API_KEY` is required. `AI_PROVIDER=openai` is accepted by configuration but reported as "adapter not implemented" until an adapter exists.

## ADR-016 Resend for transactional email — Accepted (Phase 2)

**Decision:** Resend sends app email (invitations, approval notifications, run alerts) via `RESEND_API_KEY` + `EMAIL_FROM` on a verified subdomain (e.g. `mail.nexefiy.com`). Supabase Auth emails use Resend's SMTP relay configured in the Supabase dashboard, so one provider handles domain reputation. Email is optional at runtime: without it, email-dependent features fall back (invitation links can be copied from the UI) and say so.

## ADR-017 Feature-gated environment configuration — Accepted (Phase 2)

**Decision:** `src/lib/env` validates configuration at startup. Only the Supabase URL, publishable key, and (in production) app URL are required. Every other credential belongs to one feature; when it is missing or invalid, that feature reports `not_configured` / `misconfigured` / `blocked` and `requireFeature()` throws `FeatureUnavailableError` with setup instructions at the point of use, while the rest of the app keeps working. Any secret-looking value or name in a `NEXT_PUBLIC_*` variable stops startup. Messages name variables but never include values.

## ADR-018 Rendering and caching: Cache Components off — Accepted (Phase 4)

**Context:** Next.js 16 can cache rendered output and data (`cacheComponents`, `'use cache'`). Signed-in pages show one workspace's data; a cache key that misses the user or workspace would show it to someone else.
**Decision:** Cache Components stay off. Every `/app` route reads cookies and renders per request; responses that set auth cookies carry no-cache headers. Public website pages hold no tenant data and are prerendered at build time.
**Consequences:** No cross-tenant cache leaks by construction; signed-in pages pay a render per request. Revisit only with tenant-scoped cache keys and tests that prove isolation.

## ADR-019 Dependency pinning and TypeScript 6/7 side by side — Accepted (Phase 4)

**Decision:**
- Exact versions only. At install time choose the newest release that is at least about a week old, so a compromised or broken release has time to be caught. Installed in Phase 4: `next` 16.4.0, `react`/`react-dom` 19.3.0, `@supabase/ssr` 0.12.7, `radix-ui` 1.7.0, `lucide-react` 1.54.0, `tailwindcss` 4.3.3, `shadcn` 4.21.4, `eslint` 10.12.0, `eslint-config-next` 16.4.0.
- typescript-eslint does not support the TypeScript 7 JS API. Following Microsoft's side-by-side guidance, `@typescript/native` (TypeScript 7.0.2) provides the `tsc` command and the `typescript` package name is aliased to `@typescript/typescript6` (6.0) for tools that load the compiler API.
**Consequences:** `tsc --noEmit`, ESLint, `next build` and Vitest all pass. Drop the alias when typescript-eslint supports TypeScript 7.

## ADR-020 Public website and application in one Next.js app — Accepted (Phase 5)

**Context:** The public website needs `/`, which the application shell used for its overview.
**Decision:**
- The website lives in `src/app/(site)` at `/`; the signed-in application moved under `/app` (`APP_HOME`). One deployment and one origin: `NEXT_PUBLIC_APP_URL` is the site's address (e.g. `https://nexefiy.com`).
- The proxy (session refresh) runs only for `/app`, so website pages stay static.
- Website content comes from `src/modules/marketing/domain`, where every capability has a status: `built`, `first_release` or `later`. Tests require repository evidence for each `built` claim and reject testimonials, customer logos, customer or integration counts, prices, and outcome figures.
- Public pages are indexable only when `APP_ENV=production`; account pages, legal drafts and `/app` are never indexed. `robots.txt` and `sitemap.xml` are generated from the same page list.
- The contact form delivers each message by email (Resend) to `CONTACT_FORM_TO` (feature `contactForm`, which depends on `email`). Messages are not stored and their content is never logged. Without configuration the form is shown disabled and the server refuses submissions.

**Alternatives:** a separate marketing site (another repository or a CMS) adds moving parts before there is content to manage; an `app.` subdomain via host-based routing in the proxy remains possible later without moving pages again.
**Consequences:** Links into the application use `/app/...`. A CMS or separate site can replace `(site)` later; the domain data shows what must be carried over.

## ADR-021 Authentication, sessions and workspace membership — Accepted (Phase 6)

**Context:** People need accounts, workspaces and teammates, with permissions enforced by the database rather than the interface.
**Decision:**
- **Supabase Auth, email and password**, through Server Actions using the user's own session (`@supabase/ssr` cookies). Email links use the PKCE code exchange at `/auth/callback`; `/auth/confirm` handles token-hash links for customized templates. Redirect targets after sign-in or an email link are limited to known in-app paths (`safeNextPath`).
- **Two session checks.** Rendering verifies the access token locally (`getClaims`, ES256 keys). Every Server Action that changes data calls `getUser`, which asks Supabase Auth, so a session ended elsewhere can no longer change anything. The proxy runs only on `/app` and the account pages and redirects by session state; pages and actions still check for themselves.
- **Authorization lives in the database.** Actions run under the user's session; RLS and `private.guard_membership_change` decide. A change that touches no rows is reported as not allowed. The interface hides controls by mirroring the rules (`memberPermissions`) but never decides.
- **Removing a member** sets the membership to `revoked` (keeps who and when); leaving deletes your own membership. Access ends at once because policies count only active memberships, and the role is read from the database on every request, so role changes also apply immediately.
- **Invitations** carry a one-time token (only its hash is stored). The link puts the token in the URL fragment (`/invite#token`), which browsers never send to servers, so it stays out of request logs and Referer headers. The invitee sees what the invitation is for through `get_invitation()` and joins with `accept_invitation()`, which requires their confirmed email to match. Without email configured, the person inviting gets the link once to share.
- **Onboarding progress is derived** from workspace data (name, company details, other members or invitations) rather than stored, so it can't claim a step that didn't happen.
- The active workspace stays a cookie preference, checked against memberships on every request (as in Phase 4).

**Alternatives:** client-side auth calls from the browser (simpler, but scatters error handling and rate limiting); tokens in the invitation URL path or query (simpler, but ends up in logs); storing onboarding state (can drift from reality).
**Consequences:** Another device keeps read access until its access token expires after "sign out everywhere"; custom SMTP is needed before outside users can sign up; CI and end-to-end tests are a separate phase.


## ADR-022 Business context and the knowledge pipeline — Accepted (Phase 7)

**Context:** AI employees need the organization's facts (profile, hours, brand voice, goals, departments, procedures, contacts, templates, FAQs) and its documents, with sources, without letting any of that content act as instructions or cross an organization boundary. Durable execution (Trigger.dev) does not exist yet.
**Decision:**
- **Structured context:** company profile, hours and brand voice live in `company_settings` (columns plus `settings` JSON validated by `private.company_settings_is_valid` v1). List-shaped context lives in one table, `business_context_items`, with a `kind` and per-kind attribute schemas (`private.business_context_attributes_are_valid`). Operators manage most kinds; escalation contacts and communication templates are admin-only (contacts decide where information goes; saving a template is its approval). Employees receive the structured context as a pack (`formatBusinessContextForModel`), including whether the business is open now in its own time zone.
- **One retrieval path:** every indexed context item gets a `business_context` knowledge source, kept in sync by a trigger, so FAQs, procedures, products and templates are searchable and citable alongside documents. Escalation contacts are deliberately not indexed.
- **Files:** a private `knowledge` bucket; objects live under `<organization_id>/<upload_id>/<file>`; storage policies let members read and operators upload/delete only in their organization's folder. Browsers upload directly under their own session; the server then confirms the object and records the source. Formats: PDF (`unpdf`), DOCX (`mammoth`), text, Markdown, CSV, HTML, up to 20 MB.
- **Queue in Postgres:** `claim_knowledge_sources` (service role, `FOR UPDATE SKIP LOCKED`) leases sources; every completion is conditional on still holding the lease; passing failures retry with backoff (1, 5, 15 minutes, 3 attempts); file problems fail at once with a readable reason; expired leases are reclaimed. Processing is nudged with `after()` on each change and by `/api/cron/knowledge`; Trigger.dev can later call the same `processKnowledgeQueue` without schema changes.
- **Hybrid search:** chunks carry a generated `tsvector` (English) alongside the optional Voyage embedding. `search_knowledge` (SECURITY INVOKER, explicit organization filter) merges keyword and vector candidates by reciprocal rank fusion. Without `VOYAGE_API_KEY` documents are still indexed and searchable by keyword.
- **Evidence, not instructions:** retrieval returns cited passages plus a sufficiency verdict (semantic similarity ≥ 0.45, or the top passages cover at least half of the question's meaningful words). Passages reach a model only inside delimited `<knowledge_excerpt>` blocks with a preamble saying they are untrusted data that cannot grant permissions; delimiters inside content are neutralized; passages that look like prompt injection are flagged (not hidden) at indexing time and shown to people.

**Alternatives:** separate tables per context kind (more migrations and policies for the same shape); server-side uploads through Server Actions (body limits, double transfer); waiting for Trigger.dev (blocks the phase; the Postgres queue is what Trigger.dev would drive anyway); vector-only search (unusable without an embedding key, weaker on exact terms).
**Consequences:** reprocessing a ready document removes it from search until it is ready again; keyword search uses English stemming; URL and integration sources, OCR for scanned PDFs, and live Voyage verification are later work.

## ADR-023 Integration framework, HubSpot and Slack first — Accepted (Phase 8)

**Context:** AI employees and workflows need to act in the business apps customers use, under the same server-side rules wherever the request comes from (rule 2), with credentials that never leave the server (rule 3, ADR-014). The first working workflow needs a CRM and a communication tool. Durable execution and AI employees don't exist yet; the schema for tool executions, approvals and policies does (Phase 3).
**Decision:**
- **Declarative connectors.** Each provider is one `ConnectorDefinition` (`src/modules/integrations/connectors`) declaring authentication (OAuth 2.0 code flow: exchange, refresh, revoke), scopes, rate-limit buckets with their provider source, request timeouts, health check and error normalization; each action declares Zod input/output schemas, scopes, risk, approval requirement, idempotency strategy, per-attempt timeout and retry policy. Connectors contain no permission, policy or approval logic.
- **One executor.** `requestAction` / `runExecution` enforce, in order: role, input schema, organization-scoped connection, provider, granted scopes, enabled setting, decision = strictest of connection setting, declared requirement and organization policies (a policy can only tighten; `always` can't be relaxed; rules with unevaluated conditions never allow). Every request is recorded as a manual task + tool execution under the caller's idempotency key.
- **Approvals bind to the exact payload.** The approval request shows the full input; `input_sha256` is the SHA-256 of canonical JSON of action, connection and input; the exact input waits in `tool_executions.pending_input` (hidden from clients by column grants, clearable but never replaceable, cleared automatically when an execution ends). Running re-checks connection, scopes, setting and fingerprint. Approved executions are claimed from Postgres (`claim_tool_executions`, leases, `FOR UPDATE SKIP LOCKED`) by an after-approval nudge or `/api/cron/integrations`.
- **Idempotency drives retries.** Read actions retry transient failures; `natural_key` actions (HubSpot upsert by email, with 409 handled by updating the named contact) repeat safely; `not_idempotent` actions (HubSpot notes, Slack messages) are retried only when the provider certainly didn't receive the request, and end as `outcome_unknown` after a timeout or a lost lease instead of being resent.
- **Shared rate limits.** Fixed-window counters in Postgres per connection and bucket (`consume_integration_rate_limit`), checked before each request; provider 429s and Retry-After remain authoritative.
- **Token renewal under a lease** on the secret row; one forced renewal when a provider rejects a token; then `needs_reauth`.
- **Disconnect = revoke + delete + cancel.** Provider revocation is best effort and reported; credentials are deleted and pending executions cancelled regardless; the connection row stays (`revoked`) for history.
- **HubSpot + Slack first:** free test accounts, no provider security review before testing (Gmail's restricted scopes need one), and together they cover "new lead → CRM contact + note → team notification". HubSpot uses date-versioned APIs (OAuth `2026-03`, CRM `2026-09`).

**Alternatives:** per-provider SDKs (more dependencies and token handling outside our control; plain `fetch` keeps every request visible and testable); storing only redacted inputs (approvals couldn't run the approved payload); in-memory rate limiting (not shared between serverless instances); Redis (another service for one counter); retrying every failure (duplicate messages and notes).
**Consequences:** live verification against real HubSpot and Slack accounts is still required (docs/integration-architecture.md §7); inbound webhooks and triggers, Gmail/Calendar, and employee actors come later; fixed windows allow short bursts at window edges.

## ADR-024 Employee builder: versioned configuration, test-gated activation — Accepted (Phase 9)

**Context:** Businesses must be able to describe an employee or pick a template, review a complete configuration, test it, and decide when it may act. Employees of every department must run on one runtime (product principle). Only HubSpot, Slack and knowledge search exist as tools. Durable execution and task assignment don't exist yet.
**Decision:**
- **Configuration v2 in immutable versions.** Every reviewed field (profile, responsibilities, instructions, skills, tools with connection and approval rule, knowledge access, model tier/effort/output, success criteria, allowed/prohibited actions, escalation, limits, budget) is one version, validated by Zod and by SQL (`private.employee_config_is_valid` v2) plus server-side semantic checks. The latest version is `current_version_id`; the version that runs is `active_version_id`, changed only by activation.
- **Five states without widening the old status check:** "testing" is a draft with `testing_started_at`; a generated `lifecycle_status` column reports draft/testing/active/paused/archived. All transitions go through `change_employee_status`, which checks the role per action, the transition, and for activation the latest version, a passing test status and the typed name, then replaces the employee's tool and skill grants with exactly the version's and writes an audit event. (This also keeps the migration free of DROP statements, which the database connector holds for the owner.)
- **Test-gated activation.** A version can be activated only when every saved test case's latest run on it passed and no free-form run waits for review (`private.employee_version_test_status`).
- **One runtime, pluggable invokers.** `runEmployee` owns the loop and all limits (steps, tool calls, time, per-task cost, monthly budget) and refuses ungranted tools. The test invoker never runs writes; it previews the decision with the integration executor's rules and runs only reads that would run without approval (through `requestAction`, recorded). Live work will use the same runtime with an employee-actor invoker.
- **Drafting never invents capabilities.** Model drafting uses structured output against a small proposal schema, then normalization against the real tool catalog; without a model, labelled keyword rules. Unsupported requests are shown, not dropped.
- **Model gateway on the official Anthropic SDK** behind a provider-neutral interface; tiers map to Claude Haiku 5.5 / Sonnet 5.5 / Opus 5.5; no sampling parameters or forced tool choice (rejected by the 5.5 models); effort via `output_config.effort`.

**Alternatives:** editing an active employee in place (what runs would change without a test); activating without tests (no evidence it behaves); dry-running every tool call (reads would be fake, so tests couldn't show real CRM duplicates); letting templates list planned tools (advertises capabilities that don't exist); a separate runtime per department (the product principle forbids it).
**Consequences:** nothing can be tested until an AI model key is configured (nothing is simulated); active employees can't be given work until task assignment ships; costs exclude prompt caching (not used yet); `employee_builder` must be applied (owner confirmation in the database connector) before any of this works against the dev project.

## ADR-025 Task runtime: Postgres queue with checkpoints, employee actor, verified results — Accepted (Phase 10)

**Context:** Active employees must complete bounded tasks with real, authorized tools, survive waits (approvals, a requester's reply) and stopped servers, stay within limits, resist prompt injection, and never be believed just because they say an action succeeded. Trigger.dev isn't set up; the schema already separates tasks, attempts, tool executions and approvals.
**Decision:**
- **Postgres queue with leases, nudged after responses and by cron** (`claim_employee_tasks`, `/api/cron/tasks`), like the executor and knowledge queues. The lease (330 s) outlives a route's 300 s limit, so a live worker never loses it mid-step.
- **Checkpoint after every step** (`task_attempts.checkpoint`: conversation, counters, the last turn's calls and their results). A paused or recovered task continues exactly there; tool calls are idempotent per model call id (`task:<task>:<call>`), so a resumed step never repeats an action. Limits count across segments; time counts only while running; budget counts spend already recorded.
- **Attempts are tries, not segments.** Waiting continues the same attempt; only a failure (transient model error, lost worker) starts a new one, up to `max_attempts`, with backoff. Failures are classified (transient / permanent / limit / task) and only transient ones are retried.
- **The employee is an actor of the executor**, not a borrowed user: it must be active, on its own running task, with the tool granted on that connection at activation; its approval rule and suspicious-content rule are floors that only add approval; executions and approvals record the employee, version, task and attempt; the executor never finishes an employee's task (the runtime does), and re-checks the employee and grant before running an approved action.
- **Resumption after a decision is a database trigger** on tool executions, so approval, rejection, expiry and cancellation all re-queue a waiting task with no extra code path.
- **Results are verified against the executor's records.** The employee reports through a `finish_task` tool (status, summary, receipts); the runner re-reads the task's tool executions and fails the task if a cited receipt didn't succeed, and flags unbacked claims, pending and failed actions for review.
- **Untrusted results are framed, scrubbed and flagged;** after instruction-like content every write in the task needs approval.
- **Evidence is its own table** (`task_evidence`), immutable, secret-checked; knowledge chunks are referenced by id only so reprocessing documents doesn't break history.

**Alternatives:** Trigger.dev now (no keys; the queue moves there later without changing the tables); restarting a task from scratch after an approval (repeats reads and costs, and the model loses what it saw); one attempt per segment (waiting would use up retries); trusting the model's "done" (the risk this phase exists to remove); an LLM judge for verification (costly, and still model output).
**Consequences:** tasks need the Supabase secret key and an AI model to run; without them they stay queued and the pages say so. There is no cron schedule (`vercel.json`) yet, so a task whose nudge didn't run waits until the cron route is called. `task_runtime` must be applied after `knowledge_pipeline` and `employee_builder` (owner confirmation in the database connector).

## ADR-026 Durable execution: Trigger.dev executes, Postgres records — Accepted (Phase 11)

**Context:** Tasks must be queued, run, wait for approvals or replies for hours or days, pause, resume, retry, time out, depend on other tasks and be cancelled — surviving deploys, serverless timeouts and lost workers — without long work inside web requests. Phase 10 left a Postgres queue with leases and per-step checkpoints, nudged by `after()` and a cron route. ADR-004 picked Trigger.dev v4 with thin wrappers; ADR-005 made Postgres the source of truth.
**Decision:**
- **The engine runs jobs; every state change is in Postgres.** `trigger/employee-tasks.ts` defines three jobs: `employee-tasks.sweep` (every minute), `employee-tasks.dispatch` (on demand) and `employee-tasks.run` (one task). Dispatch (`src/modules/tasks/server/dispatch.ts`) expires overdue approvals, times out tasks past their deadline, runs approved actions, lists due tasks and starts one job per task. **Nothing is claimed by the dispatcher:** each job claims its own task (`claim_employee_tasks(p_task_id)`), so a job that starts late, twice or after someone else took the task does nothing.
- **Job keys per task state.** A job's idempotency key is `employee-task:<task>:<updated_at>`, so one queued state gets one job and a changed task (re-queued after a decision, recovered after a lost lease) gets a new one. Jobs of an organization share a concurrency key, so one workspace can't occupy every worker.
- **Waits stay in Postgres, not engine waitpoints.** A task waiting for approval or a reply holds no compute and no engine run; the database trigger on tool executions (and the reply/resume/retry functions) re-queues it, and the next dispatch starts a job. This keeps the engine replaceable and means a decision taken while no worker exists is never lost. (docs/agent-orchestration.md described waitpoints; updated.)
- **Engine retries are off for task jobs.** Retries are attempts in Postgres with failure classes and backoff (ADR-025); the engine retries only the dispatcher.
- **A superseded worker stops without writing.** Every checkpoint and settlement is conditional on the worker's attempt still being the running one; a worker whose lease expired and was replaced gets "superseded" and writes nothing more.
- **Life cycle in SQL** (`durable_execution` migration): a `paused` state (pause/resume; a running task pauses after its step; a paused employee pauses its task), per-task deadlines (`deadline_at`, swept by `time_out_overdue_tasks` and checked before every step), dependencies (`task_dependencies`: a task waits as `pending`, is queued when all succeed, skipped when one doesn't — transitively), priority and reassignment before work starts, manual retry from the last checkpoint with a fresh set of run limits (`limitBaseline` in the checkpoint) and three more attempts, and cancellation that withdraws pending approvals at once even mid-step (the executor also refuses new actions for a task being cancelled).
- **Cancellation is honest about what it can't undo.** The cancel dialog, the action's answer and the task page list the actions that already changed something outside Nexefiy (with receipts) and any action running at that moment.
- **Without the engine** (development, or before Trigger.dev is set up), requests run one bounded, checkpointed segment after the response and `/api/cron/tasks` runs the dispatcher inline. The task page says when no engine is configured.
- **Local database tests.** `npm run db:test:local` applies every migration to a throwaway PostgreSQL 16 with a small Supabase stand-in (`supabase/local/`: roles, `auth`, `storage`, `pg_jsonschema` via Python's jsonschema) and runs pgTAP plus `tests/integration` — the real runner, executor, dispatcher and SQL together through a Supabase-client adapter over `pg`. It is evidence about our SQL and code, not about the hosted platform.

**Alternatives:** waitpoints for approvals (holds engine state the database already has; a decision made before the token is stored is lost; harder to replace the engine); the dispatcher claiming tasks and passing claims to jobs (a delayed job could run a task whose lease was re-taken); engine-level retries for task jobs (would duplicate attempts the database already counts); Inngest/Temporal (ADR-004); keeping only the Postgres queue with cron (works, but runs work in requests and polls once a minute at best).
**Consequences:** Trigger.dev's API is not reachable from the environment this was built in and no project keys exist, so **no job has run on Trigger.dev yet** — the wrappers are typechecked, bundled with the `react-server` condition (no Next.js-only code), and unit-tested with the SDK mocked. Deploying needs `TRIGGER_PROJECT_REF`/`TRIGGER_SECRET_KEY` and the application's server variables in the Trigger.dev project (docs/credential-setup.md). The `durable_execution` migration must be applied after `task_runtime`.


# System Architecture

## 1. Overview

Nexefiy is a **modular monolith** (one Next.js application) plus a **durable execution worker** (Trigger.dev tasks deployed from the same repository), backed by **Supabase** (Postgres + Auth + Storage). Module boundaries are enforced by folder structure, import rules, and per-module service APIs, so a module can later be extracted into a service without redesign (ADR-001).

```
 Browser (React, RSC)                         External apps (Gmail, Slack, HubSpot, …)
     │  publishable key + user JWT only              ▲                │ webhooks
     ▼                                               │                ▼
 ┌──────────────────────── Next.js on Vercel ─────────────────────────────────┐
 │ app/ (pages, server actions, route handlers)                              │
 │   identity · knowledge · employees · workflows · governance · analytics … │
 │   ── module services (server-only) ──                                      │
 │   tool executor ─ policy engine ─ integration adapters ─ model gateway     │
 └───────────────┬────────────────────────────────┬───────────────────────────┘
                 │ user-scoped client (RLS)       │ trigger tasks / resume waitpoints
                 ▼                                ▼
          ┌────────────┐                ┌──────────────────────┐
          │  Supabase  │◄───────────────│ Trigger.dev workers  │
          │ Postgres   │ service client │ employee runs, wf    │
          │ Auth       │ (org-scoped)   │ steps, retries, waits│
          │ Storage    │                └─────────┬────────────┘
          └────────────┘                          │
                                                  ▼
                                   Model providers (Anthropic, others)
```

## 2. Modules

| # | Module | Folder | Responsibilities | Owns tables |
|---|---|---|---|---|
| 0 | Public website | `app/(site)`, `modules/marketing` | Public pages at `/`, capability status model, contact form (email). | — |
| 1 | Application interface | `app/app`, `modules/app-shell` | Signed-in application under `/app`: layouts, org switcher, navigation, design system. | — |
| 2 | Identity & organizations | `modules/identity` | Auth session, profiles, orgs, memberships, invitations, roles. | `profiles`, `organizations`, `organization_members`, `organization_invitations` |
| 3 | Business context & knowledge | `modules/knowledge` | Business profile, documents, chunking, embeddings, retrieval. | `business_profiles`, `knowledge_collections`, `knowledge_documents`, `knowledge_chunks` |
| 4 | AI employee configuration | `modules/employees` | Templates, employees, versions, grants. | `employee_templates`, `employees`, `employee_versions`, `employee_tool_grants`, `employee_knowledge_grants` |
| 5 | Model-provider abstraction | `modules/models` | `ModelGateway` interface, provider adapters, model tiers, token/cost accounting. | `model_usage` |
| 6 | Skills & typed tools | `modules/skills` | Tool registry, schemas, risk levels, tool executor. | `tool_invocations` |
| 7 | Integration adapters | `modules/integrations` | OAuth flows, credential storage, adapters, webhooks, health. | `integration_connections`, `integration_webhook_events` |
| 8 | Durable workflow execution | `modules/workflows`, `trigger/` | Definitions, versions, validation, runs, steps, triggers, schedules. | `workflows`, `workflow_versions`, `workflow_runs`, `workflow_run_steps`, `workflow_triggers` |
| 9 | Approvals & policy | `modules/governance` | Policy evaluation, approval requests/decisions, kill switches, limits. | `policies`, `approval_requests` |
| 10 | Task history & observability | `modules/observability` | Tasks, timelines, audit events, structured logs. | `tasks`, `task_events`, `audit_events` |
| 11 | Analytics & outcomes | `modules/analytics` | Aggregations, outcome metrics, dashboards. | `outcome_events`, materialized views |
| 12 | Billing & entitlements | `modules/billing` | Stripe customers/subscriptions, plans, entitlements, metering. | `billing_customers`, `subscriptions`, `plan_entitlements`, `usage_counters` |

### Dependency direction

```
app-shell → (all modules' ui + public services)
workflows → employees, skills, governance, observability, billing
employees → models, skills, knowledge, governance, observability
skills    → integrations, governance, observability
integrations → observability
governance → observability, billing (limits)
analytics → reads from observability/billing views only
identity  ← everyone (org context)
```

No cycles. `domain/` folders have no I/O and can be imported anywhere.

## 3. Request paths

### 3.1 Interactive UI (user-scoped)
1. Browser → Next.js server component / server action with Supabase auth cookie.
2. Server creates a **user-scoped** Supabase client (publishable key + user JWT). RLS enforces tenancy.
3. Module service validates input (Zod), checks role, performs query.

### 3.2 Background execution (worker)
1. User action or trigger enqueues a Trigger.dev task with `{ organizationId, runId }` only — never secrets or large payloads.
2. Worker loads state from Postgres using a **service client wrapper** (`createOrgScopedServiceClient(orgId)`) that injects `organization_id` filters and refuses queries without one.
3. Each step is persisted (`workflow_run_steps`) before and after execution; tool calls go through the tool executor; waits (approval, delay) use Trigger.dev waitpoints, with the waitpoint id stored on the step.

### 3.3 Inbound webhooks
`/api/webhooks/<provider>` → verify signature → store raw event reference in `integration_webhook_events` (dedupe by provider event id) → resolve connection → org → enqueue trigger task → return 2xx fast.

## 4. Supervised execution loop (employee task)

```
load employee version + context  →  model call (with tool schemas)
   → model proposes tool call(s)
   → tool executor: validate input schema → authorize (org, grant, entitlement, connection)
   → policy engine: allow | require_approval | deny
        allow            → execute via adapter (idempotency key) → record result
        require_approval → persist approval_request, wait on waitpoint → on decision resume
        deny             → return structured refusal to the model
   → loop until final answer / step limit / budget limit
   → record task outcome, usage, audit events
```

Hard limits per run: max model turns, max tool calls, max cost, max wall time. Exceeding any ends the run with a clear status.

## 5. Cross-cutting concerns

- **Configuration:** `src/lib/env.ts` validates env vars with Zod at boot; separate `serverEnv` and `clientEnv` objects.
- **Errors:** typed `AppError` with codes; never leak stack traces or provider error bodies to clients.
- **Logging:** structured JSON logs with `organization_id`, `run_id`, `task_id`; redaction helper for PII/secrets.
- **Time:** all timestamps `timestamptz`, UTC.
- **IDs:** UUID v4 (`gen_random_uuid()`), public-facing.
- **Feature flags:** entitlement-driven + simple `feature_flags` env for unfinished features.

## 6. Deployment

| Component | Target |
|---|---|
| Web app + route handlers | Vercel (region close to eu-north-1, e.g. `arn1`/`fra1`) |
| Durable workers | Trigger.dev Cloud (EU region if available) |
| Database/Auth/Storage | Supabase project `rnqrqconfbcrmszllxgu` (eu-north-1) |
| Environments | `local` → `preview` (Vercel previews + Supabase branch) → `production` |

## 7. Scaling path

Start as one deployable. Extraction candidates, in likely order: (1) worker runtime (already separate via Trigger.dev), (2) integration webhook ingestion, (3) knowledge ingestion/embedding pipeline, (4) voice runtime (needs low-latency, long-lived connections — will not run on Vercel functions).

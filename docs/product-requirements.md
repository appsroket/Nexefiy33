# Product Requirements

Requirement IDs are stable; reference them in code comments, tests, and PRs. Priority: **P0** = MVP, **P1** = shortly after MVP, **P2** = later.

## 1. Authentication and organizations

| ID | Requirement | Pri |
|---|---|---|
| AUTH-1 | Users sign up / sign in with email + password and magic link via Supabase Auth. | P0 |
| AUTH-2 | Google OAuth sign-in. | P1 |
| AUTH-3 | Sessions handled with `@supabase/ssr` cookies; server components read the user server-side. | P0 |
| ORG-1 | A user can create an organization and becomes its `owner`. | P0 |
| ORG-2 | A user can belong to multiple organizations and switch the active one. | P0 |
| ORG-3 | Roles: `owner`, `admin`, `operator`, `viewer`. Owners/admins manage members, integrations, billing, policies; operators run the workforce (employees, knowledge, workflows, approvals); viewers read. Permission matrix: database-design.md §3. | P0 |
| ORG-4 | Invite members by email with expiring, single-use tokens. | P0 |
| ORG-5 | Ownership transfer; an org always has ≥1 owner. | P1 |
| ORG-6 | Organization deletion with data export and grace period. | P2 |

## 2. Business context and knowledge

| ID | Requirement | Pri |
|---|---|---|
| KNOW-1 | Business profile: name, industry, description, offerings, tone of voice, hours, locations, policies. | P0 |
| KNOW-2 | Upload documents (PDF, DOCX, TXT, MD) to Supabase Storage; parse, chunk, embed (pgvector). | P0 |
| KNOW-3 | Add knowledge from URLs (fetched server-side, with SSRF protection). | P1 |
| KNOW-4 | Knowledge collections that can be granted per employee. | P0 |
| KNOW-5 | Retrieval returns cited chunks; employees cite sources in outputs where relevant. | P0 |
| KNOW-6 | Re-index on document update; delete removes chunks and embeddings. | P0 |

## 3. AI employees

| ID | Requirement | Pri |
|---|---|---|
| EMP-1 | Create an employee from a template or blank: name, role, avatar, instructions, model tier. | P0 |
| EMP-2 | Grant skills/tools, knowledge collections, and integration connections per employee. | P0 |
| EMP-3 | Employee configuration is versioned; runs record the version used. | P0 |
| EMP-4 | Status: `draft`, `active`, `paused`, `archived`. Pausing stops new work and halts in-flight runs at the next step. | P0 |
| EMP-5 | Chat with an employee (assign ad-hoc tasks) in the app. | P0 |
| EMP-6 | Templates for support, sales, executive assistant at MVP; others post-MVP. | P0 |
| EMP-7 | Voice employees (inbound/outbound calls) via telephony provider. | P2 |
| EMP-8 | Per-employee autonomy settings within org policy bounds. | P1 |

## 4. Skills, tools, and integrations

| ID | Requirement | Pri |
|---|---|---|
| TOOL-1 | Every tool has a typed input/output schema (Zod), risk level, required scopes, and required integration. | P0 |
| TOOL-2 | Tool calls are executed only by the server-side tool executor after authorization and policy checks. | P0 |
| TOOL-3 | Idempotency keys on all external write tools. | P0 |
| INT-1 | OAuth-based connection flow per organization; credentials encrypted with application-level AES-256-GCM (ADR-014) and never sent to the browser. | P0 |
| INT-2 | MVP adapters: Gmail, Google Calendar, Slack, HubSpot, generic outbound webhook. | P0 |
| INT-3 | Inbound triggers via verified webhooks (signature validation) and polling where webhooks are unavailable. | P0 |
| INT-4 | Connection health status; token refresh; clear "reconnect required" state. | P0 |
| INT-5 | Additional adapters (Outlook, Zendesk, Shopify, QuickBooks, Twilio, …). | P1–P2 |

## 5. Workflows

| ID | Requirement | Pri |
|---|---|---|
| WF-1 | Create a workflow from a natural-language description; the system generates a validated draft definition. | P0 |
| WF-2 | Visual editor (React Flow) to edit nodes, edges, and configuration. | P0 |
| WF-3 | Manual configuration of every node via forms (no model required). | P0 |
| WF-4 | Triggers: manual, schedule (cron), integration event, webhook. | P0 |
| WF-5 | Node types: employee task, tool action, condition, approval, delay, parallel/join (P1), loop over list (P1), sub-workflow (P2). | P0 |
| WF-6 | Draft → validate → publish creates an immutable version; runs pin a version. | P0 |
| WF-7 | Test run with dry-run mode (external writes simulated and labelled as simulated). | P1 |

## 6. Governance and supervision

| ID | Requirement | Pri |
|---|---|---|
| GOV-1 | Policy engine decides `allow` / `require_approval` / `deny` per tool call from risk level, org policy, employee settings, and context. | P0 |
| GOV-2 | Approval inbox: view proposed action, rationale, inputs; approve, edit-and-approve, or reject; optional expiry. | P0 |
| GOV-3 | Notifications for pending approvals (in-app; email P0; Slack P1). | P0 |
| GOV-4 | Global and per-employee kill switch. | P0 |
| GOV-5 | Spending and rate limits per employee and org (model cost, actions/day). | P0 |
| GOV-6 | Append-only audit log viewable by owners/admins; export (P1). | P0 |

## 7. Tasks, observability, analytics

| ID | Requirement | Pri |
|---|---|---|
| OBS-1 | Every unit of work is a `task` with status, timeline of steps, tool calls, approvals, model usage, and errors. | P0 |
| OBS-2 | Run detail view shows each step, inputs/outputs (redacted where sensitive), and policy decisions. | P0 |
| OBS-3 | Retry failed steps; cancel runs. | P0 |
| ANA-1 | Dashboard: tasks completed, success rate, approval rate, median time-to-complete, model cost, per employee. | P0 |
| ANA-2 | Outcome metrics defined per template (e.g. meetings booked, tickets resolved, leads contacted). | P1 |

## 8. Billing and entitlements

| ID | Requirement | Pri |
|---|---|---|
| BILL-1 | Stripe Checkout + Customer Portal for subscriptions per organization. | P0 |
| BILL-2 | Entitlements (max employees, max workflows, integrations, monthly task/credit quota) enforced server-side. | P0 |
| BILL-3 | Usage metering of model cost and tasks; soft and hard limits. | P0 |
| BILL-4 | Free trial; dunning handled via Stripe; access degrades gracefully on failed payment. | P0 |

## 9. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Tenant isolation enforced in the database (RLS) and re-checked in services. |
| NFR-2 | p95 page load < 2.5s on dashboard pages; API route p95 < 500ms excluding model calls. |
| NFR-3 | Durable runs survive deploys and function timeouts; at-least-once step execution with idempotent tools. |
| NFR-4 | Accessibility: WCAG 2.2 AA for core flows. |
| NFR-5 | Data residency: primary database in EU (eu-north-1). |
| NFR-6 | GDPR: data export and deletion per organization and user. |
| NFR-7 | All secrets server-side; dependency and secret scanning in CI. |

# Database Design

Implemented schema (Phase 3; business context and knowledge pipeline added in Phase 7). PostgreSQL 17 on Supabase project `rnqrqconfbcrmszllxgu`. Source of truth: `supabase/migrations/`. Generated types: `src/lib/supabase/database.types.ts`. Operations (apply, test, generate types): [supabase-setup.md](supabase-setup.md).

## 1. Conventions

- **Identity:** Supabase Auth (`auth.users`) only. `public.profiles` mirrors name/email/avatar via triggers. No password data in `public`.
- **Keys:** `uuid` primary keys (`gen_random_uuid()`); `bigint identity` for append-only, high-volume tables (`audit_logs`, `execution_events`, `usage_records`).
- **Tenancy:** every tenant table has `organization_id` and `UNIQUE (id, organization_id)`. Children reference parents with **composite foreign keys** `(parent_id, organization_id)`, so a row can never point at another organization's data — even if a client lies about `organization_id`.
- **Timestamps:** `timestamptz` only; `created_at` default `now()`; `updated_at` maintained by `private.set_updated_at()`.
- **Status values:** `text` + `CHECK (... in (...))` (easier to evolve than enums). Lifecycle consistency is also checked, e.g. finished tasks must have `completed_at`, failed ones an `error`.
- **Deletion:** explicit per FK — `cascade` for owned children, `set null (column)` for optional references, `no action` for history that must not dangle (run → published version).
- **JSON:** `jsonb` objects, validated by versioned JSON schemas where structure matters, and scanned by `private.jsonb_contains_secret()` everywhere so provider credentials can never be stored in configuration.
- **Money:** integer minor units (`*_minor bigint`) for prices and outcome values; integer micro-units (`cost_micros`, 1/1,000,000) for usage costs; always paired with an ISO 4217 `currency` (`^[A-Z]{3}$`). No floats.
- **Idempotency:** `UNIQUE (organization_id, idempotency_key)` on `workflow_runs`, `tasks`, `tool_executions`, `usage_records`, `outcome_records`; `UNIQUE (provider, event_id)` on `provider_webhook_events`.

## 2. Schemas

| Schema | Contents | Exposed by Data API |
|---|---|---|
| `public` | Application tables (34) and 9 RPCs | yes, under RLS + explicit grants |
| `private` | Helper, validator, and trigger functions | no |
| `extensions` | `pgcrypto`, `vector` 0.8, `pg_jsonschema` | no |
| `vault` | Supabase Vault — not used for customer credentials (ADR-014) | no |

## 3. Roles and permissions

Roles: `owner` > `admin` > `operator` > `viewer` (`private.role_rank`). Membership `status` is `active` or `revoked`; revoked and removed members lose all access immediately.

| Capability | viewer | operator | admin | owner | server (service role) |
|---|---|---|---|---|---|
| Read organization data (employees, knowledge, workflows, runs, tasks, approvals, outcomes) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage employees, versions, skills, knowledge sources, workflow drafts & triggers | | ✓ | ✓ | ✓ | ✓ |
| Decide approvals (per `required_role`, default operator) | | ✓ | ✓ | ✓ | |
| Grant tools to employees, manage integrations & actions, policies, company settings | | | ✓ | ✓ | ✓ |
| Manage members & invitations (operators/viewers) | | | ✓ | ✓ | ✓ |
| Manage admins/owners, invite admins, delete organization | | | | ✓ | ✓ |
| Read audit log, subscriptions, usage & cost | | | ✓ | ✓ | ✓ |
| Read or write integration credentials | | | | | ✓ |
| Write execution state, publish workflow versions, billing records | | | | | ✓ |

Anonymous users can read only the public plan catalog.

## 4. Tables

### Identity and organizations
| Table | Purpose | Notes |
|---|---|---|
| `profiles` | Display data for `auth.users` | Created by trigger on sign-up; visible to self and co-members |
| `organizations` | Tenants | Created only via `create_organization()` |
| `organization_members` | User ↔ organization with role/status | PK `(organization_id, user_id)`; guarded by `private.guard_membership_change()` (role rules, last-owner rule, records `revoked_at/by`) |
| `organization_invitations` | Pending invitations | Stores `token_hash` (SHA-256) only; one pending invite per email (a lapsed one is marked `expired` when the address is invited again); created via `create_invitation()`, looked up by the token holder via `get_invitation()`, accepted via `accept_invitation()` |
| `company_settings` | Company profile per organization | One row per org; `settings` JSON (profile, operating hours, brand voice) validated by `private.company_settings_is_valid` v1 and secret-scanned; admins update |

### Business context and knowledge (ADR-022)
| Table | Purpose | Notes |
|---|---|---|
| `business_context_items` | Products and services, target customers, goals and KPIs, departments, procedures, escalation contacts, communication templates, FAQs | `kind` + title, body, `attributes` validated per kind (`private.business_context_attributes_are_valid`); `kind` not updatable; operators manage, except `escalation_contact` and `template` (admins); status `active`/`archived`; audited |
| `knowledge_sources` | Documents, URLs, text, integration content, business context | Status `pending → processing → ready / failed / archived`; processing lease (`processing_attempts`, `processing_started_at`) and retry time (`next_attempt_at`) written only by the server; storage path must live under `<organization_id>/` with no `.`/`..` segments; client-created files must be in the `knowledge` bucket; `business_context` sources (one per indexed item, `context_item_id`) are created, renamed, re-queued and archived only by the `sync_knowledge_source` trigger; audited |
| `knowledge_chunks` | Content chunks + embeddings | Generated `search_vector` (English `tsvector`, GIN index) for keyword search; optional `vector(1024)` from **Voyage `voyage-4`** (ADR-008), HNSW cosine index, `embedding_model` per chunk; written by the processing worker (service role) |

Storage: private bucket `knowledge` (20 MB, PDF/DOCX/text/Markdown/CSV/HTML). Policies on `storage.objects`: members read, operators upload and delete, only under their organization's folder (`<organization_id>/…`).

Retrieval: `search_knowledge(org, query, embedding?, count, source_ids?)` — hybrid keyword + vector search over `ready` sources, merged by reciprocal rank fusion; `SECURITY INVOKER` with an explicit organization filter, so RLS applies to members and the service role is still held to the organization it asks for. `match_knowledge_chunks` (vector only) remains.

Queue: `claim_knowledge_sources(limit, org?, lease_seconds, max_attempts)` — service role only; leases due sources with `FOR UPDATE SKIP LOCKED`, reclaims expired leases, fails sources whose lease expired `max_attempts` times. `reprocess_knowledge_source(id)` — operators re-queue a `ready` or `failed` source of their organization.

### AI workforce
| Table | Purpose | Notes |
|---|---|---|
| `skills` | Skill catalog | `organization_id NULL` = built-in (5 seeded); org skills unique per key |
| `ai_employees` | Employees | Category, status; `current_version_id` → own versions only; cannot be active without a version |
| `employee_versions` | Immutable configuration + instructions | Version number assigned by trigger; `config` validated against **employee config schema v1**; no secrets in config or instructions; updates rejected |
| `employee_skills` | Employee ↔ skill (M:N) | Skill must be built-in or same organization |
| `employee_tool_permissions` | Per-employee tool ceiling (`allow`/`require_approval`/`deny`) | Optionally bound to an integration of the same org; admin-only |

### Integrations
| Table | Purpose | Notes |
|---|---|---|
| `integrations` | Connections (provider, account, scopes, status, `health_status`/`health_message`) | Created by the server OAuth callback; members read metadata; health and error text are secret-scanned |
| `integration_actions` | Actions enabled per connection with risk level & approval mode | `sensitive` actions can never be `allow`; seeded with each action's declared default on connect. The executor takes risk from the connector code, never from this row |
| `integration_secrets` | **Encrypted** credentials | Only `nxf1.` AES-256-GCM envelopes accepted (ADR-014); `key_id` must match the envelope; `refresh_lease_until` serializes token renewal; RLS on, no policies, no client grants — service role only |
| `integration_oauth_states` | Pending OAuth authorizations (Phase 8) | SHA-256 of the state only; bound to organization, user, provider and optional connection (composite FK); `return_path` must stay under `/app`; expires within an hour; single use; service role only |
| `integration_rate_limit_windows` | Shared provider rate-limit counters (Phase 8) | Per connection, bucket and fixed window; written only through `consume_integration_rate_limit`; service role only |

### Workflows
| Table | Purpose | Notes |
|---|---|---|
| `workflow_definitions` | Editable metadata + draft graph | `lock_version` bumped on every update (optimistic locking) |
| `workflow_versions` | Immutable published graphs | Graph validated against **workflow graph schema v1** + structural checks (unique node ids, edges reference nodes); `graph_sha256` computed by trigger; published by the server only |
| `workflow_triggers` | manual / schedule / integration_event / webhook | Webhook triggers store only a secret hash |

### Execution
| Table | Purpose | Notes |
|---|---|---|
| `workflow_runs` | Run of a pinned workflow version | Status lifecycle, `engine_run_id`, idempotency key |
| `tasks` | Units of work (workflow node, chat, manual, API, schedule) | Pins `employee_version_id`; attempts bounded by `max_attempts` |
| `task_dependencies` | Task DAG (M:N) | Same run only; cycles rejected by trigger |
| `task_attempts` | Retry history | `attempt_number` unique per task |
| `tool_executions` | Each tool call: redacted input, `input_sha256`, policy decision, status, `attempt_count`, `requested_by` | Proposed action immutable after insert; `deny` ⇒ `skipped`; `require_approval` cannot run without an approved approval for the exact fingerprint. `pending_input` (exact validated input until it runs) is not selectable by clients (column grants), can be cleared but not replaced, and is cleared automatically when the execution ends; `executing` ⇔ `lease_expires_at` set. `claim_tool_executions` (service role) leases approved executions and expired leases |
| `execution_events` | Append-only event stream | Secret-scanned; updates rejected |

### Governance
| Table | Purpose | Notes |
|---|---|---|
| `organization_policies` | Approval policy documents | **Policy schema v1**; `revision` bumped on change; default policy created with each organization |
| `approval_requests` | Human decisions bound to an action | `payload_sha256` must equal the tool execution's `input_sha256`; records employee/workflow version and policy revision; proposed action immutable; decisions via `decide_approval()` only |
| `audit_logs` | Append-only audit trail | Written by triggers on 16 tables (column names + allow-listed values only); no FKs so history outlives deleted rows; updates/deletes rejected except `private.purge_audit_logs()` (≥ 365 days, service role) |

### Billing and outcomes
| Table | Purpose | Notes |
|---|---|---|
| `plans` | Plan catalog (4 seeded, prices TBD) | Public read |
| `plan_entitlements` | Limits per plan | `NULL` limit = unlimited |
| `subscriptions` | Stripe (or manual) subscription mirror | One live subscription per org; admins read; server writes |
| `usage_records` | Metering (tasks, tokens, cost) | Append-only; `cost_micros` + currency |
| `outcome_records` | Business outcomes for analytics | Members read |
| `provider_webhook_events` | Webhook idempotency | Fingerprint only, never raw payloads; service role only |

## 5. Versioned JSON schemas

| Validator | Used by | Versions |
|---|---|---|
| `private.employee_config_is_valid(version, config)` | `employee_versions.config` | v1: `modelTier`, optional `model`, `channels`, required `limits` (turns, tool calls, cost), `outputStyle`, `knowledge` |
| `private.workflow_graph_is_valid(version, graph)` | `workflow_versions.graph` | v1: `nodes` (`employee_task`, `tool_action`, `condition`, `approval`, `delay`), `edges`, `settings` + structural checks |
| `private.policy_document_is_valid(version, policy)` | `organization_policies.policy` | v1: `rules[]` with `effect`, `toolKeys`, `riskLevels`, `employeeIds`, `conditions`; `defaults` |
| `private.company_settings_is_valid(settings)` | `company_settings.settings` | v1 (`schemaVersion` 1 or absent): `profile`, `operatingHours.weekly` (up to 3 `open`/`close` ranges per weekday, 24-hour times), `brandVoice` |
| `private.business_context_attributes_are_valid(kind, attributes)` | `business_context_items.attributes` | One schema per kind (e.g. templates require `channel`; escalation contacts require `email` or `phone`) |

To evolve a format: add a new branch (`when 2 then …`) in a new migration with `create or replace function`, never change an existing branch.

## 6. Row Level Security

- RLS is enabled on all 34 tables; every client-visible table has explicit per-command policies (`to authenticated`), and `anon` has no table privileges except the plan catalog.
- Policies use `organization_id in (select private.member_org_ids())` or `private.org_ids_with_min_role('<role>')` — evaluated once per statement, derived only from `auth.uid()`; a client-supplied organization id is never trusted.
- Privileges are granted explicitly per table and per column after revoking Supabase defaults, so even a mistaken policy cannot let clients write columns such as `status`, `created_by`, or `organization_id` on update.

### SECURITY DEFINER review

| Function | Why definer | Safeguards |
|---|---|---|
| `private.member_org_ids`, `org_ids_with_min_role`, `has_min_role`, `co_member_user_ids` | Read memberships inside policies without RLS recursion | Answer only for `auth.uid()`; `search_path = ''`; not executable by `anon` |
| `private.handle_new_user`, `sync_user_email` | Triggers on `auth.users` | Write only the matching profile row |
| `private.audit_row_change` | Insert audit rows regardless of caller | Stores column names and allow-listed values only |
| `private.assign_employee_version`, `assign_workflow_version` | Number versions across all rows | Only read `max(version)` for the inserted row's parent |
| `private.purge_audit_logs` | Retention | Service role only; refuses anything newer than 365 days |
| `public.create_organization`, `create_invitation`, `accept_invitation`, `decide_approval` | Write rows clients cannot write directly | Derive the user from `auth.uid()`, check membership/role inside, `authenticated` only, generic errors for unknown ids/tokens |
| `public.reprocess_knowledge_source` | Change `status` and processing columns clients cannot write | Only `ready`/`failed` sources in organizations where the caller is operator or above; generic error otherwise; `authenticated` only |
| `private.sync_business_context_source` | Trigger: keep one knowledge source per indexed context item | Writes only the source of the changed item, in the item's organization; skips escalation contacts |
| `public.get_invitation` | Lets an invitee see an invitation before joining (they can't read invitation rows) | Only by token (32 random bytes; malformed tokens return nothing); returns the workspace name, role, status, invited address and whether it matches the caller's confirmed email; `authenticated` only |

Phase 8's `consume_integration_rate_limit` and `claim_tool_executions` are SECURITY INVOKER and executable only by `service_role`.

The Supabase security advisor reports these RPCs (WARN, *authenticated can execute SECURITY DEFINER*; five while `knowledge_pipeline` is unapplied) and four tables with RLS but no policies (INFO, `integration_secrets`, `integration_oauth_states`, `integration_rate_limit_windows`, `provider_webhook_events`). Both are intentional and covered by tests.

## 7. Migrations

| Version | Name | Contents |
|---|---|---|
| 20261017215558 | foundation | extensions, `private` schema, timestamps, role rank, secret scan, JSON schema validators |
| 20261017215654 | identity | profiles, organizations, members, invitations, company settings, membership helpers & guard |
| 20261017215719 | knowledge | sources, chunks, HNSW index, `match_knowledge_chunks` |
| 20261017215759 | workforce | skills (+ 5 built-ins), employees, versions, employee skills, tool permissions |
| 20261017215823 | integrations | integrations, actions, encrypted secrets, deferred FKs |
| 20261017215853 | workflows | definitions, versions, triggers |
| 20261017215939 | execution | runs, tasks, dependencies, attempts, tool executions, events |
| 20261017220022 | governance | policies, approval binding, audit log + triggers |
| 20261017220059 | billing | plans (+ seed), entitlements, subscriptions, usage, outcomes, webhook idempotency |
| 20261017220124 | api_functions | `create_organization`, `create_invitation`, `accept_invitation`, `decide_approval` |
| 20261017221324 | version_numbering_definer | fix found by the tenant-isolation tests (see migration comment) |
| 20261017221856 | foreign_key_indexes | indexes for tenant FKs without a leading index |
| 20261018102320 | invitation_lookup | `get_invitation()`; `create_invitation()` expires a lapsed invitation before re-inviting and reports a live one |
| 20261018145032 | business_context | `company_settings` JSON schema, `business_context_items` (Phase 7) |
| 20261018154440 | integration_framework | OAuth states, refresh lease, rate-limit windows + `consume_integration_rate_limit`, connection health, tool-execution pending input/attempts/lease + `claim_tool_executions`, pending-input column grants (Phase 8) |
| (pending) | knowledge_pipeline | `knowledge` bucket + storage policies, source processing columns, business context sources + sync trigger, chunk `search_vector`, `search_knowledge`, `claim_knowledge_sources`, `reprocess_knowledge_source` (Phase 7) |

## 8. Known gaps (by design, revisit later)

- `created_by` / `updated_by`-style user references are not indexed; user deletion is rare. The performance advisor lists them (INFO).
- When an employee is deleted, `tasks.employee_version_id` keeps the old id if `employee_id` was cleared first (the composite FK is then not enforced). Historical only; no cross-tenant risk.
- Approval expiry is applied when someone tries to decide; a scheduled job to expire stale approvals belongs to the durable-execution phase.
- Retention jobs (`execution_events`, webhook events) are not scheduled yet.

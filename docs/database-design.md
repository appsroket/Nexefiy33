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
| Manage employees, versions, skills, knowledge sources, workflow drafts; start, cancel and pause workflow runs/workflows | | ✓ | ✓ | ✓ | ✓ |
| Activate workflow versions (server validates, then `publish_workflow_version`), resume, archive and restore workflows | | | ✓ | ✓ | ✓ |
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
| `skills` | Skill catalog | `organization_id NULL` = built-in (5 seeded; since `employee_builder` the Gmail and Calendar skills are `deprecated` and the CRM/chat skills list the real HubSpot/Slack action keys; since `employee_skills_catalog` 30 active built-ins with their procedures in `instructions`, mirroring `src/modules/employees/domain/skills.ts`); org skills unique per key and may not reuse a built-in key (`check_skill_key_reserved` trigger) |
| `ai_employees` | Employees | Department (`role_category`), `status`; `lifecycle_status` (generated: draft, testing, active, paused, archived — "testing" is a draft with `testing_started_at`); `current_version_id` = latest saved version, `active_version_id` = the version an admin activated (what runs); `activated_at/by`; `template_key`. Clients can't write status or version pointers (only `change_employee_status` can); the profile is copied from each saved v2 version; only never-activated drafts can be deleted |
| `employee_versions` | Immutable configuration + instructions | Version number assigned by trigger; `config` validated against **employee config schema v1 or v2**; no secrets in config or instructions; updates rejected; inserting one makes it current (`private.apply_employee_version`); archived employees can't get new versions |
| `employee_test_cases` | Saved playground requests with expectations (tools used / not used / waiting for approval, reply mentions, escalation) | Operators manage; expectations JSON schema-checked; unique name per employee |
| `employee_test_runs` | Every playground run: version, input, result (`running`/`passed`/`failed`/`needs_review`/`error`), outcome, reply, transcript, checks, model, tokens, cost, reviewer verdict | Written by the server only; members read; verdicts through `review_employee_test_run` |
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
| `workflow_definitions` | Editable metadata + draft graph | `lock_version` bumped on every update (optimistic locking). Phase 12: `draft_layout` (positions, apart from the graph), `draft_source`, `draft_generation` (secret-scanned), `draft_validation`, `activated_at/_by`. Clients write only the draft columns (column grants); status and the current version change through `publish_workflow_version` (service role) and `change_workflow_status`; only never-activated drafts can be deleted |
| `workflow_versions` | Immutable published graphs | Graph validated against **workflow graph schema v1 or v2** (v2: inputs, eight step types, branches, settings; unique ids, one trigger, at least one end, connections between existing steps, none into the trigger or out of an end, no cycles); `graph_sha256` computed by trigger; `layout`; `validation_report` (permissions, hand-offs); published by the server only |
| `workflow_triggers` | manual / schedule / integration_event / webhook | Webhook triggers store only a secret hash. Phase 12: `workflow_version_id`; registered by activation only (clients can't write them); schedules started by `start_scheduled_workflow_run` |

### Execution
| Table | Purpose | Notes |
|---|---|---|
| `workflow_runs` | Run of a pinned workflow version | Status lifecycle, `engine_run_id`, idempotency key. Phase 12: `authorized_by` (the version's activator), `deadline_at`, the orchestrator's `lease_token`/`lease_expires_at` (claimed by `claim_workflow_runs`), `advance_requested_at` (set by the `wake_workflow_run` trigger when a step's task changes), `wake_at` (delays, retries), `summary`, `output`. Started by `start_workflow_run` (operators; inputs checked by `private.workflow_inputs_are_valid`), cancelled by `cancel_workflow_run` |
| `workflow_run_steps` | One row per step a run reached or skipped | Phase 12. Status, branch taken, attempt, the step's task, due time, input/output (secret-scanned), error; written only through `record_workflow_progress` while holding the run's lease; a finished step never changes; members read |
| `tasks` | Units of work (workflow node, chat, manual, API, schedule) | Pins `employee_version_id`; attempts bounded by `max_attempts`. Employee tasks (Phase 10): assigned through `assign_employee_task`, `lease_expires_at` set exactly while running (claimed by `claim_employee_tasks`), `cancel_requested_at`; title/instructions secret-scanned; re-queued by trigger when their last pending tool execution finishes. Phase 11: `paused` status with `paused_at`/`paused_from` (consistent by check) and `pause_requested_at`; `deadline_at`; operators control tasks through `cancel_`/`pause_`/`resume_`/`retry_employee_task`, `set_employee_task_priority`, `reassign_employee_task`; `time_out_overdue_tasks` (service role) fails overdue waiting tasks |
| `task_dependencies` | Task DAG (M:N) | Same run only; cycles rejected by trigger. Phase 11: when a task succeeds its pending dependents whose dependencies all succeeded are queued; when it fails, is cancelled or skipped they are skipped (`dependency_not_met`), transitively (`settle_dependent_tasks` trigger) |
| `task_attempts` | Tries at a task | `attempt_number` unique per task; usage (`model`, tokens, `cost_micros`, `turn_count`, `tool_call_count`, `active_ms`) and the runtime `checkpoint` (secret-scanned, ≤ 2 MB, **not selectable by clients**). Waiting continues an attempt; a failure or lost worker starts a new one |
| `task_evidence` | What a task observed (knowledge passages, integration results) | Phase 10; excerpt ≤ 4000 chars, secret-scanned; immutable; composite FKs to task, attempt, tool execution, knowledge source (chunks by id only); server writes, members read |
| `tool_executions` | Each tool call: redacted input, `input_sha256`, policy decision, status, `attempt_count`, `requested_by` | Proposed action immutable after insert; `deny` ⇒ `skipped`; `require_approval` cannot run without an approved approval for the exact fingerprint. `pending_input` (exact validated input until it runs) is not selectable by clients (column grants), can be cleared but not replaced, and is cleared automatically when the execution ends; `executing` ⇔ `lease_expires_at` set. `claim_tool_executions` (service role) leases approved executions and expired leases |
| `execution_events` | Append-only event stream | Secret-scanned; updates rejected |

### Governance
| Table | Purpose | Notes |
|---|---|---|
| `organization_policies` | Approval policy documents | **Policy schema v1 and v2** (v2 since `governance_controls`: rules by tool key/category/tier/risk/employee/actor with approver role, separate approver and expiry; `approvals`, `tools.allowlist`, `dataAccess`, `limits`); `revision` bumped on document, enabled, priority or name changes; `authorized_by`/`authorized_role` stamped by trigger from the saving member (null when no member saved it — then its allow rules waive nothing); default policy created with each organization |
| `organization_policy_versions` | Every policy revision (Phase 14) | One immutable row per created/updated/deleted revision with the document and who authorized it; kept after the policy is deleted; members read |
| `organization_governance` | Emergency stop and retention (Phase 14) | One row per workspace: `emergency_stop_at/_by/_reason`, retention days for evidence, events and payloads (30–3650 or null = keep), `retention_hold`, `last_purged_at`; members read; written only through `set_emergency_stop`, `lift_emergency_stop`, `set_retention_settings`, `purge_expired_task_data` |
| `approval_requests` | Human decisions bound to an action | Phase 14: `action_category`, `risk_tier`, `separate_approver`, `binding` (connection account, versions, policy revisions), all immutable; only a signed-in member with `required_role` can approve (trigger), never the requester when `separate_approver`, never during an emergency stop. `kind`: `tool_action` (`payload_sha256` must equal the tool execution's `input_sha256`) or `workflow_gate` (Phase 12: an approval step's task; the database sets `payload_sha256` to the SHA-256 of `proposed_action`, i.e. exactly what the approver sees; one per step). Records employee/workflow version and policy revision; proposed action immutable; decisions via `decide_approval()` only, which also settles a gate's task |
| `audit_logs` | Append-only audit trail | Written by triggers on 16 tables (column names + allow-listed values only); no FKs so history outlives deleted rows; updates/deletes rejected except `private.purge_audit_logs()` (≥ 365 days, service role) |

### Billing and outcomes
| Table | Purpose | Notes |
|---|---|---|
| `plans` | Plan catalog (4 seeded, prices TBD) | Public read |
| `plan_entitlements` | Limits per plan | `NULL` limit = unlimited |
| `subscriptions` | Stripe (or manual) subscription mirror | One live subscription per org; admins read; server writes |
| `usage_records` | Metering (tasks, tokens, cost) | Append-only; `cost_micros` + currency |
| `outcome_records` | Business outcomes for analytics | Members read; since `analytics`: written by the `record_action_outcomes` trigger when an AI action succeeds, with `tool_execution_id` and `subject` (provider record id) as evidence (docs/analytics.md) |
| `provider_webhook_events` | Webhook idempotency | Fingerprint only, never raw payloads; service role only |

## 5. Versioned JSON schemas

| Validator | Used by | Versions |
|---|---|---|
| `private.employee_config_is_valid(version, config)` | `employee_versions.config` | v1: `modelTier`, optional `model`, `channels`, required `limits` (turns, tool calls, cost), `outputStyle`, `knowledge`. v2 (Phase 9, written by the builder): `profile`, `responsibilities`, `skills`, `tools` (key, connection, approval), `knowledge` (access, sources, passages), `model` (provider, tier, effort, max output tokens), `successCriteria`, `allowedActions`, `prohibitedActions`, `escalation`, `limits` (turns, tool calls, cost, runtime), `budget`; plus unique tools and non-empty selected sources |
| `private.workflow_graph_is_valid(version, graph)` | `workflow_versions.graph` | v1: `nodes` (`employee_task`, `tool_action`, `condition`, `approval`, `delay`), `edges`, `settings` + structural checks. v2 (Phase 12): `inputs`, `nodes` (`trigger`, `employee_task`, `tool_action`, `condition`, `approval`, `transform`, `delay`, `end`), `edges` with `branch`, `settings`; one trigger, an end, no cycles. Step settings and references are validated by the server (ADR-027) |
| `private.policy_document_is_valid(version, policy)` | `organization_policies.policy` | v1: `rules[]` with `effect`, `toolKeys`, `riskLevels`, `employeeIds`, `conditions`; `defaults`. v2 (Phase 14): rules add `categories`, `tiers`, `actors`, `approverRole`, `separateApprover`, `approvalExpiresInHours` (no `conditions`); `approvals`, `tools`, `dataAccess`, `limits` |
| `private.company_settings_is_valid(settings)` | `company_settings.settings` | v1 (`schemaVersion` 1 or absent): `profile`, `operatingHours.weekly` (up to 3 `open`/`close` ranges per weekday, 24-hour times), `brandVoice` |
| `private.business_context_attributes_are_valid(kind, attributes)` | `business_context_items.attributes` | One schema per kind (e.g. templates require `channel`; escalation contacts require `email` or `phone`) |

To evolve a format: add a new branch (`when 2 then …`) in a new migration with `create or replace function`, never change an existing branch.

## 6. Row Level Security

- RLS is enabled on every table (36 applied; 38 once `employee_builder` is applied); every client-visible table has explicit per-command policies (`to authenticated`), and `anon` has no table privileges except the plan catalog.
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
| `public.change_employee_status` | Move status and version pointers, sync grants on activation, write the activation audit event | Role per action (operator: start testing, back to draft, pause; admin: activate, resume, archive, restore) checked with `private.has_min_role` on the employee's own organization; activation needs the latest version, its tests passed (`private.employee_version_test_status`) and the typed name; generic P0002 for unknown ids or too-low roles |
| `public.review_employee_test_run` | Clients can't write test runs | Operator of the run's organization; only `needs_review` → passed/failed or passed → failed |
| `private.apply_employee_version` | Trigger: make a new version current and copy its profile (clients can't update those columns) | Updates only the inserted version's own employee in its organization; refuses archived employees |
| `public.assign_employee_task`, `cancel_employee_task`, `reply_to_employee_task` | Create and change tasks, attempts, approvals and events clients can't write | Operator of the task's (or employee's) organization via `private.has_min_role`; assignment only to active employees, pinned to the active version, idempotent per key; credential-shaped text refused; generic P0002 for unknown ids or too-low roles; `authenticated` only |
| `public.get_invitation` | Lets an invitee see an invitation before joining (they can't read invitation rows) | Only by token (32 random bytes; malformed tokens return nothing); returns the workspace name, role, status, invited address and whether it matches the caller's confirmed email; `authenticated` only |

Phase 8's `consume_integration_rate_limit` and `claim_tool_executions`, and Phase 10's `claim_employee_tasks` and `expire_overdue_approvals`, are SECURITY INVOKER and executable only by `service_role`; the trigger `private.requeue_task_after_tool_execution` runs as the caller (the executor's service role, or `decide_approval`'s definer). Phase 9's `create_employee`, `save_employee_version` and `employee_test_summary` are SECURITY INVOKER (RLS applies).

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
| 20261019201204 | knowledge_pipeline | `knowledge` bucket + storage policies, source processing columns, business context sources + sync trigger, chunk `search_vector`, `search_knowledge`, `claim_knowledge_sources`, `reprocess_knowledge_source` (Phase 7) |
| 20261019201352 | employee_builder | employee lifecycle (`testing_started_at`, `active_version_id`, generated `lifecycle_status`), config schema v2, `employee_test_cases`, `employee_test_runs`, `create_employee`, `save_employee_version`, `change_employee_status`, `review_employee_test_run`, `employee_test_summary`, column grants, delete only unactivated drafts, skills catalog limited to real tools (Phase 9) |
| 20261019201500 | task_runtime | task leases and cancellation, attempt usage + checkpoint (column grants), `task_evidence`, `assign_employee_task`, `claim_employee_tasks`, `cancel_employee_task`, `reply_to_employee_task`, `expire_overdue_approvals`, re-queue trigger on tool executions (Phase 10) |
| 20261019201631 | durable_execution | `paused` state, deadlines, pause/resume/retry/priority/reassign functions, dependency release/skip trigger, `claim_employee_tasks(p_task_id)`, cancellation that withdraws approvals mid-step, `time_out_overdue_tasks` (Phase 11) |
| 20261019201845 | workflow_builder | graph schema v2, draft layout/source/validation, client column grants, delete only never-activated drafts, `workflow_run_steps`, run lease/wake/deadline/authority columns, `wake_workflow_run` trigger, `workflow_gate` approvals (fingerprint set by the database) with `decide_approval`/`expire_overdue_approvals` settling gates, `publish_workflow_version`, `change_workflow_status`, `start_workflow_run`, `start_scheduled_workflow_run`, `cancel_workflow_run`, `claim_workflow_runs`, `record_workflow_progress` (Phase 12) |
| 20261019201930 | employee_skills_catalog | 30 active built-in skills for every category (upsert by key, procedures in `instructions`), `private.check_skill_key_reserved` trigger (Phase 13) |
| 20261019202213 | governance_controls | Policy documents v2, `organization_policy_versions`, `organization_governance`, policy authorization stamps, task handoff/emergency columns, execution/approval category, tier and binding, approval guard (signed-in member only, separate approver, stop), stop-aware claims, revocation triggers, allowlist trigger, `set_/lift_emergency_stop`, `emergency_stop_employee`, `revoke_employee_tool`, `hand_off_employee_task`, `complete_handed_off_task`, `set_retention_settings`, `purge_expired_task_data` (Phase 14) |
| 20261019202348 | analytics | `outcome_records.tool_execution_id`/`subject`, `private.action_outcomes` + trigger `record_action_outcomes` (with backfill), audit target index, facts functions `private.analytics_{task,action,run,outcome}_facts`, member RPCs `analytics_task_metrics`, `analytics_task_failures`, `analytics_action_metrics`, `analytics_workflow_metrics`, `analytics_outcome_metrics`, `analytics_evidence`, admin RPC `analytics_model_usage` (Phase 15) |
| 20261019211513 | retention_guard_strict | `private.guard_tool_execution` and `private.guard_approval_request`: an unset `nexefiy.retention_purge` flag means "not purging" (was NULL, which skipped the payload checks); while purging only the exact purged shape is accepted, once; a purge mark cannot be cleared (pgTAP 015) |

## 8. Known gaps (by design, revisit later)

- `created_by` / `updated_by`-style user references are not indexed; user deletion is rare. The performance advisor lists them (INFO).
- When an employee is deleted, `tasks.employee_version_id` keeps the old id if `employee_id` was cleared first (the composite FK is then not enforced). Historical only; no cross-tenant risk.
- Approval expiry: `expire_overdue_approvals` (Phase 10) runs from `/api/cron/tasks`; there is no cron schedule yet, so until then expiry also happens when someone tries to decide.
- Retention jobs (`execution_events`, webhook events) are not scheduled yet.

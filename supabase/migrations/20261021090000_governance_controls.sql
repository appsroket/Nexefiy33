-- Governance controls (ADR-029).
--
--   1. Policy documents, version 2: rules by action category and risk tier,
--      approval settings (approver role, separate approver, expiry), tool
--      allowlists, data-access restrictions, spending and duration limits.
--      Every change is stamped with the role of the person who made it (an
--      "allow" only counts when that role may waive approval) and kept as an
--      immutable version.
--   2. Approval integrity: only a signed-in member with the required role can
--      approve, never the service role an AI employee runs as; a policy can
--      require someone other than the requester to approve; approvals record
--      what they were bound to (connection account, versions, tier).
--   3. Emergency stop for a workspace (pauses AI tasks, cancels workflow runs,
--      withdraws pending approvals, blocks new AI work and any AI action from
--      starting) and for one employee.
--   4. Revocation: removing an employee's tool, or disconnecting a connection,
--      cancels the actions waiting on it, whichever path removed it.
--   5. Human handoff: a person takes over an employee's task; the employee
--      can't pick it up again.
--   6. Evidence retention: per-workspace retention for evidence, execution
--      events and action payloads, with a hold; purged by the service role.

-- ---------------------------------------------------------------------------
-- 1. Policy documents, version 2
-- ---------------------------------------------------------------------------

create or replace function private.policy_document_is_valid(p_schema_version integer, p_policy jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_schema_version
    when 1 then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "required": ["rules"],
        "properties": {
          "rules": {
            "type": "array",
            "maxItems": 500,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["effect"],
              "properties": {
                "id": { "type": "string", "maxLength": 64 },
                "description": { "type": "string", "maxLength": 500 },
                "effect": { "enum": ["allow", "require_approval", "deny"] },
                "toolKeys": { "type": "array", "items": { "type": "string", "maxLength": 100 } },
                "riskLevels": {
                  "type": "array",
                  "items": { "enum": ["read", "write_internal", "write_external", "sensitive"] }
                },
                "employeeIds": { "type": "array", "items": { "type": "string", "maxLength": 36 } },
                "conditions": { "type": "object" }
              }
            }
          },
          "defaults": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "approvalExpiresInHours": { "type": "integer", "minimum": 1, "maximum": 720 }
            }
          }
        }
      }$schema$::json,
      p_policy
    )
    when 2 then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "required": ["rules"],
        "properties": {
          "rules": {
            "type": "array",
            "maxItems": 200,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["effect"],
              "properties": {
                "id": { "type": "string", "maxLength": 64 },
                "description": { "type": "string", "maxLength": 500 },
                "effect": { "enum": ["allow", "require_approval", "deny"] },
                "toolKeys": { "type": "array", "maxItems": 100, "items": { "type": "string", "maxLength": 100 } },
                "categories": {
                  "type": "array",
                  "items": { "enum": ["read", "draft", "internal_update", "record_change", "external_message", "financial", "personnel", "destructive"] }
                },
                "tiers": { "type": "array", "items": { "enum": ["low", "medium", "high", "critical"] } },
                "riskLevels": {
                  "type": "array",
                  "items": { "enum": ["read", "write_internal", "write_external", "sensitive"] }
                },
                "employeeIds": { "type": "array", "maxItems": 200, "items": { "type": "string", "maxLength": 36 } },
                "actors": { "type": "array", "items": { "enum": ["employee", "workflow", "person"] } },
                "approverRole": { "enum": ["operator", "admin", "owner"] },
                "separateApprover": { "type": "boolean" },
                "approvalExpiresInHours": { "type": "integer", "minimum": 1, "maximum": 720 }
              }
            }
          },
          "approvals": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "expiresInHours": { "type": "integer", "minimum": 1, "maximum": 720 },
              "separateApprover": { "type": "boolean" }
            }
          },
          "tools": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "allowlist": { "type": "array", "maxItems": 200, "items": { "type": "string", "maxLength": 100 } }
            }
          },
          "dataAccess": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "blockedSourceIds": { "type": "array", "maxItems": 500, "items": { "type": "string", "maxLength": 36 } },
              "requireSelectedSources": { "type": "boolean" }
            }
          },
          "limits": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "maxTaskRuntimeSeconds": { "type": "integer", "minimum": 10, "maximum": 900 },
              "maxCostUsdPerTask": { "type": "number", "minimum": 0.01, "maximum": 50 },
              "employeeMonthlyUsd": { "type": "number", "minimum": 1, "maximum": 10000 },
              "organizationMonthlyUsd": { "type": "number", "minimum": 1, "maximum": 100000 }
            }
          }
        }
      }$schema$::json,
      p_policy
    )
    else false
  end;
$$;

-- Who made the current revision, and with which role. An "allow" rule only
-- waives approval when this role may authorize it (application rule, see
-- src/modules/governance/domain/risk.ts); service-role writes authorize nothing.
alter table public.organization_policies
  add column authorized_by uuid references auth.users (id) on delete set null,
  add column authorized_role text check (authorized_role in ('owner', 'admin'));

create index organization_policies_authorized_by_idx on public.organization_policies (authorized_by)
  where authorized_by is not null;

create or replace function private.bump_policy_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.policy is distinct from old.policy
     or new.policy_schema_version <> old.policy_schema_version
     or new.enabled <> old.enabled
     or new.priority <> old.priority
     or new.name <> old.name then
    new.revision := old.revision + 1;
  else
    new.revision := old.revision;
  end if;
  return new;
end;
$$;

create function private.stamp_policy_authorization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
begin
  if tg_op = 'UPDATE' and new.revision = old.revision then
    new.authorized_by := old.authorized_by;
    new.authorized_role := old.authorized_role;
    return new;
  end if;
  select m.role into v_role from public.organization_members as m
  where m.organization_id = new.organization_id and m.user_id = v_uid and m.status = 'active';
  new.authorized_by := v_uid;
  new.authorized_role := case when v_role in ('owner', 'admin') then v_role end;
  return new;
end;
$$;

-- Runs after bump_policy_revision (trigger names fire in alphabetical order).
create trigger stamp_policy_authorization before insert or update on public.organization_policies
  for each row execute function private.stamp_policy_authorization();

-- Every revision of every policy, immutable; kept after the policy is deleted.
create table public.organization_policy_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  policy_id uuid not null,
  revision integer not null check (revision >= 1),
  change text not null check (change in ('created', 'updated', 'deleted')),
  name text not null,
  description text,
  policy_schema_version integer not null,
  policy jsonb not null check (not private.jsonb_contains_secret(policy)),
  enabled boolean not null,
  priority integer not null,
  authorized_by uuid references auth.users (id) on delete set null,
  authorized_role text check (authorized_role in ('owner', 'admin')),
  changed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (policy_id, revision, change)
);

create index organization_policy_versions_org_idx on public.organization_policy_versions (organization_id, created_at desc);
create index organization_policy_versions_policy_idx on public.organization_policy_versions (policy_id, revision desc);
create index organization_policy_versions_authorized_by_idx on public.organization_policy_versions (authorized_by) where authorized_by is not null;
create index organization_policy_versions_changed_by_idx on public.organization_policy_versions (changed_by) where changed_by is not null;

create trigger prevent_update before update on public.organization_policy_versions
  for each row execute function private.prevent_update();

create function private.record_policy_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.organization_policies := case when tg_op = 'DELETE' then old else new end;
begin
  if tg_op = 'UPDATE' and new.revision = old.revision then
    return null;
  end if;
  -- Deleting the workspace deletes its history too.
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations as o where o.id = old.organization_id) then
    return null;
  end if;
  insert into public.organization_policy_versions (
    organization_id, policy_id, revision, change, name, description, policy_schema_version, policy,
    enabled, priority, authorized_by, authorized_role, changed_by
  ) values (
    v_row.organization_id, v_row.id, v_row.revision,
    case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    v_row.name, v_row.description, v_row.policy_schema_version, v_row.policy,
    v_row.enabled, v_row.priority, v_row.authorized_by, v_row.authorized_role, (select auth.uid())
  );
  return null;
end;
$$;

create trigger record_policy_version after insert or update or delete on public.organization_policies
  for each row execute function private.record_policy_version();

-- Snapshots of policies that already exist.
insert into public.organization_policy_versions (
  organization_id, policy_id, revision, change, name, description, policy_schema_version, policy, enabled, priority
)
select organization_id, id, revision, 'created', name, description, policy_schema_version, policy, enabled, priority
from public.organization_policies;

-- Whether a tool may be used by AI work under every enabled allowlist.
create function private.tool_allowed(p_organization_id uuid, p_tool_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.organization_policies as p
    where p.organization_id = p_organization_id
      and p.enabled
      and p.policy_schema_version = 2
      and jsonb_typeof(p.policy -> 'tools' -> 'allowlist') = 'array'
      and not exists (
        select 1 from jsonb_array_elements_text(p.policy -> 'tools' -> 'allowlist') as a (pattern)
        where a.pattern = '*'
           or a.pattern = p_tool_key
           or (right(a.pattern, 2) = '.*' and left(p_tool_key, char_length(a.pattern) - 1) = left(a.pattern, char_length(a.pattern) - 1))
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Workspace governance settings: emergency stop and retention
-- ---------------------------------------------------------------------------

create table public.organization_governance (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  emergency_stop_at timestamptz,
  emergency_stop_by uuid references auth.users (id) on delete set null,
  emergency_stop_reason text check (char_length(emergency_stop_reason) <= 500 and not private.text_contains_secret(emergency_stop_reason)),
  -- Days to keep task evidence, execution events, and action payloads
  -- (inputs, outputs, approval details). Null keeps them.
  evidence_retention_days integer check (evidence_retention_days between 30 and 3650),
  event_retention_days integer check (event_retention_days between 30 and 3650),
  payload_retention_days integer check (payload_retention_days between 30 and 3650),
  -- A hold suspends purging (e.g. during a dispute or an investigation).
  retention_hold boolean not null default false,
  last_purged_at timestamptz,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((emergency_stop_at is null) = (emergency_stop_reason is null))
);

create index organization_governance_stop_by_idx on public.organization_governance (emergency_stop_by) where emergency_stop_by is not null;
create index organization_governance_updated_by_idx on public.organization_governance (updated_by) where updated_by is not null;

create trigger set_updated_at before update on public.organization_governance
  for each row execute function private.set_updated_at();

create function private.emergency_stopped(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_governance as g
    where g.organization_id = p_organization_id and g.emergency_stop_at is not null
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Tasks: handoff and emergency-stop bookkeeping
-- ---------------------------------------------------------------------------

alter table public.tasks
  -- The employee escalated: a person is needed.
  add column handoff_requested_at timestamptz,
  -- A person took the task over; the employee no longer works on it.
  add column handed_off_to uuid references auth.users (id) on delete set null,
  add column handed_off_by uuid references auth.users (id) on delete set null,
  add column handed_off_at timestamptz,
  add column handoff_note text check (char_length(handoff_note) <= 2000 and not private.text_contains_secret(handoff_note)),
  -- Paused by an emergency stop (so lifting it can resume exactly these).
  add column emergency_paused_at timestamptz,
  add constraint tasks_handoff_consistent check ((handed_off_at is null) = (handed_off_by is null));

create index tasks_handed_off_to_idx on public.tasks (handed_off_to) where handed_off_to is not null;
create index tasks_handed_off_by_idx on public.tasks (handed_off_by) where handed_off_by is not null;
create index tasks_emergency_paused_idx on public.tasks (organization_id) where emergency_paused_at is not null;

-- AI work (an employee's task or a workflow step) can't start while the
-- workspace is stopped: new work and resuming are refused, and an employee
-- task the system would re-queue (an action it waited on was withdrawn) is
-- parked as paused instead. A handed-off task never goes back to an employee.
create function private.guard_task_governance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('pending', 'queued', 'running')
     and (tg_op = 'INSERT' or new.status is distinct from old.status)
     and (new.employee_id is not null or new.workflow_run_id is not null)
     and private.emergency_stopped(new.organization_id) then
    if tg_op = 'UPDATE' and new.status = 'queued' and old.status in ('waiting_approval', 'blocked')
       and new.employee_id is not null and new.handed_off_at is null then
      new.status := 'paused';
      new.paused_from := 'queued';
      new.paused_at := now();
      new.emergency_paused_at := now();
      return new;
    end if;
    raise exception 'the emergency stop is active in this workspace' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and new.handed_off_at is not null
     and new.status in ('pending', 'queued', 'running', 'waiting_approval')
     and new.status is distinct from old.status then
    raise exception 'a person took over this task; the employee can''t work on it again' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger guard_task_governance before insert or update on public.tasks
  for each row execute function private.guard_task_governance();

-- ---------------------------------------------------------------------------
-- 4. Tool executions and approvals: classification and binding
-- ---------------------------------------------------------------------------

alter table public.tool_executions
  add column action_category text check (action_category in (
    'read', 'draft', 'internal_update', 'record_change', 'external_message', 'financial', 'personnel', 'destructive'
  )),
  add column risk_tier text check (risk_tier in ('low', 'medium', 'high', 'critical')),
  add column payload_purged_at timestamptz;

alter table public.approval_requests
  add column action_category text check (action_category in (
    'read', 'draft', 'internal_update', 'record_change', 'external_message', 'financial', 'personnel', 'destructive'
  )),
  add column risk_tier text check (risk_tier in ('low', 'medium', 'high', 'critical')),
  -- The requester (the person who asked, or who assigned the employee's task) may not approve.
  add column separate_approver boolean not null default false,
  -- What the approval is bound to besides the payload: connection account,
  -- employee or workflow version, policy revisions. Checked before running.
  add column binding jsonb not null default '{}'::jsonb
    check (jsonb_typeof(binding) = 'object' and not private.jsonb_contains_secret(binding));

-- An AI action can't start while the workspace is stopped.
create function private.guard_execution_governance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'executing'
     and (tg_op = 'INSERT' or old.status is distinct from 'executing')
     and private.emergency_stopped(new.organization_id)
     and (new.employee_id is not null or exists (
       select 1 from public.tasks as t where t.id = new.task_id and t.workflow_run_id is not null
     )) then
    raise exception 'the emergency stop is active in this workspace' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger guard_execution_governance before insert or update on public.tool_executions
  for each row execute function private.guard_execution_governance();

-- Retention may clear a finished execution's payload; nothing else changes it.
create or replace function private.guard_tool_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_purging boolean := current_setting('nexefiy.retention_purge', true) = 'on'
    and new.finished_at is not null and new.payload_purged_at is not null;
begin
  if new.input_sha256 <> old.input_sha256
     or (new.input_redacted <> old.input_redacted and not v_purging)
     or new.tool_key <> old.tool_key
     or new.risk_level <> old.risk_level
     or new.policy_decision <> old.policy_decision
     or new.idempotency_key <> old.idempotency_key
     or new.task_id <> old.task_id
     or new.action_category is distinct from old.action_category and old.action_category is not null
     or new.risk_tier is distinct from old.risk_tier and old.risk_tier is not null
     or (new.integration_id is distinct from old.integration_id and new.integration_id is not null)
     or (new.employee_id is distinct from old.employee_id and new.employee_id is not null) then
    raise exception 'a tool execution''s proposed action cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Only a signed-in member with the required role approves — never the
-- service role an employee or workflow runs as — and, when the approval asks
-- for a separate approver, never the person who requested the action.
create or replace function private.guard_approval_request()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_execution public.tool_executions;
  v_task public.tasks;
  v_uid uuid := (select auth.uid());
  v_purging boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'approval requests start as pending' using errcode = '23514';
    end if;
    if new.kind = 'workflow_gate' then
      select * into v_task from public.tasks as t where t.id = new.task_id;
      if v_task.id is null
         or v_task.workflow_run_id is distinct from new.workflow_run_id
         or v_task.organization_id <> new.organization_id
         or v_task.employee_id is not null
         or v_task.status <> 'waiting_approval' then
        raise exception 'a workflow approval must belong to a waiting approval step'
          using errcode = '23514';
      end if;
      -- The fingerprint is always computed here, from what the approver sees.
      new.payload_sha256 := private.sha256_hex(new.proposed_action::text);
      return new;
    end if;
    select * into v_execution from public.tool_executions as e where e.id = new.tool_execution_id;
    if v_execution.input_sha256 <> new.payload_sha256
       or v_execution.task_id <> new.task_id
       or v_execution.policy_decision <> 'require_approval'
       or v_execution.status <> 'awaiting_approval' then
      raise exception 'an approval request must match a tool execution that is awaiting approval'
        using errcode = '23514';
    end if;
    return new;
  end if;

  v_purging := current_setting('nexefiy.retention_purge', true) = 'on' and old.status <> 'pending';
  if new.organization_id <> old.organization_id
     or new.kind <> old.kind
     or new.tool_execution_id is distinct from old.tool_execution_id
     or new.task_id <> old.task_id
     or new.payload_sha256 <> old.payload_sha256
     or (new.proposed_action <> old.proposed_action and not v_purging)
     or new.action_summary <> old.action_summary
     or new.required_role <> old.required_role
     or new.expires_at <> old.expires_at
     or new.separate_approver <> old.separate_approver
     or new.binding <> old.binding
     or new.risk_tier is distinct from old.risk_tier
     or new.action_category is distinct from old.action_category then
    raise exception 'the proposed action of an approval request cannot be changed' using errcode = '42501';
  end if;
  if old.status <> 'pending' and new.status <> old.status then
    raise exception 'approval request is already %', old.status using errcode = '55000';
  end if;

  if new.status = 'approved' and old.status = 'pending' then
    if v_uid is null or new.decided_by is distinct from v_uid
       or not private.has_min_role(new.organization_id, new.required_role) then
      raise exception 'only a signed-in member with the required role can approve' using errcode = '42501';
    end if;
    if new.separate_approver and new.kind = 'tool_action' and exists (
      select 1 from public.tool_executions as e where e.id = new.tool_execution_id and e.requested_by = v_uid
    ) then
      raise exception 'someone other than the requester must approve this action' using errcode = '42501';
    end if;
    if private.emergency_stopped(new.organization_id) then
      raise exception 'the emergency stop is active in this workspace' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.decide_approval(
  p_request_id uuid,
  p_decision text,
  p_payload_sha256 text,
  p_note text default null
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.approval_requests;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;

  select * into v_request from public.approval_requests as a where a.id = p_request_id for update;

  if v_request.id is null or not private.has_min_role(v_request.organization_id, v_request.required_role) then
    raise exception 'approval request not found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'approval request is already %', v_request.status using errcode = '55000';
  end if;
  if v_request.expires_at <= now() then
    update public.approval_requests set status = 'expired', decided_at = now()
    where id = v_request.id returning * into v_request;
    update public.tool_executions set status = 'cancelled'
    where id = v_request.tool_execution_id and status = 'awaiting_approval';
    perform private.settle_workflow_gate(v_request);
    return v_request;
  end if;
  if p_payload_sha256 is distinct from v_request.payload_sha256 then
    raise exception 'the proposed action changed after you reviewed it; review it again' using errcode = '40001';
  end if;
  if p_note is not null and (char_length(p_note) > 2000 or private.text_contains_secret(p_note)) then
    raise exception 'the note is too long or looks like it contains a credential' using errcode = '22023';
  end if;
  if p_decision = 'approved' and private.emergency_stopped(v_request.organization_id) then
    raise exception 'the emergency stop is active in this workspace; lift it before approving' using errcode = '55000';
  end if;
  if p_decision = 'approved' and v_request.separate_approver and v_request.kind = 'tool_action' and exists (
    select 1 from public.tool_executions as e where e.id = v_request.tool_execution_id and e.requested_by = v_user
  ) then
    raise exception 'you requested this action, so someone else must approve it' using errcode = '42501';
  end if;

  update public.approval_requests
  set status = p_decision, decided_by = v_user, decided_at = now(), decision_note = p_note
  where id = v_request.id
  returning * into v_request;

  update public.tool_executions
  set status = p_decision
  where id = v_request.tool_execution_id and status = 'awaiting_approval';
  perform private.settle_workflow_gate(v_request);

  return v_request;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Claims skip stopped workspaces
-- ---------------------------------------------------------------------------

create or replace function public.claim_tool_executions(p_limit integer default 10, p_lease_seconds integer default 120)
returns table (tool_execution_id uuid, organization_id uuid, attempt smallint, recovered boolean)
language plpgsql
set search_path = ''
as $$
begin
  if p_limit not between 1 and 100 or p_lease_seconds not between 10 and 3600 then
    raise exception 'invalid claim parameters' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select t.id, t.status = 'executing' as was_executing
    from public.tool_executions as t
    where ((t.status = 'approved')
       or (t.status = 'executing' and t.lease_expires_at < now()))
      and not (private.emergency_stopped(t.organization_id) and (t.employee_id is not null or exists (
        select 1 from public.tasks as k where k.id = t.task_id and k.workflow_run_id is not null
      )))
    order by t.created_at
    limit p_limit
    for update skip locked
  )
  update public.tool_executions as t
  set status = 'executing',
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = least(t.attempt_count + 1, 20),
      started_at = coalesce(t.started_at, now())
  from candidates as c
  where t.id = c.id
  returning t.id, t.organization_id, t.attempt_count, c.was_executing;
end;
$$;

create or replace function public.claim_employee_tasks(
  p_limit integer default 5,
  p_lease_seconds integer default 120,
  p_task_id uuid default null
)
returns table (task_id uuid, organization_id uuid, attempt_id uuid, attempt_number smallint, new_attempt boolean, recovered boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
  v_attempt public.task_attempts%rowtype;
  v_recovered boolean;
  v_new boolean;
begin
  if p_limit not between 1 and 50 or p_lease_seconds not between 10 and 3600 then
    raise exception 'invalid claim parameters' using errcode = '22023';
  end if;

  for v_task in
    select t.* from public.tasks as t
    where t.employee_id is not null
      and (p_task_id is null or t.id = p_task_id)
      and ((t.status = 'queued' and (t.scheduled_at is null or t.scheduled_at <= now()))
        or (t.status = 'running' and t.lease_expires_at < now()))
      and not private.emergency_stopped(t.organization_id)
    order by t.priority desc, t.created_at
    limit p_limit
    for update skip locked
  loop
    v_recovered := v_task.status = 'running';
    v_new := false;
    v_attempt := null;
    select a.* into v_attempt from public.task_attempts as a
    where a.task_id = v_task.id and a.status = 'running'
    order by a.attempt_number desc limit 1;

    if v_task.cancel_requested_at is not null then
      update public.task_attempts set status = 'cancelled', finished_at = greatest(now(), started_at)
      where task_attempts.task_id = v_task.id and status = 'running';
      perform private.withdraw_task_actions(v_task.id, v_task.organization_id, null);
      update public.tasks set status = 'cancelled', lease_expires_at = null, completed_at = now()
      where id = v_task.id;
      insert into public.execution_events (organization_id, task_id, event_type, level, message)
      values (v_task.organization_id, v_task.id, 'task.cancelled', 'info', 'Task cancelled.');
      continue;
    end if;

    if v_task.deadline_at is not null and v_task.deadline_at <= now() then
      perform private.time_out_task(v_task);
      continue;
    end if;

    if v_recovered and v_attempt.id is not null then
      update public.task_attempts
      set status = 'timed_out', finished_at = greatest(now(), started_at),
          error = jsonb_build_object('code', 'worker_lost', 'class', 'transient',
            'message', 'The server running this attempt stopped.')
      where id = v_attempt.id;
      insert into public.execution_events (organization_id, task_id, event_type, level, message, data)
      values (v_task.organization_id, v_task.id, 'task.attempt_lost', 'warn',
        'The server running this task stopped; continuing from the last checkpoint.',
        jsonb_build_object('attempt', v_attempt.attempt_number));
      v_attempt := null;
    end if;

    if v_recovered and v_task.pause_requested_at is not null then
      update public.tasks
      set status = 'paused', paused_from = 'queued', paused_at = now(), pause_requested_at = null,
          lease_expires_at = null
      where id = v_task.id;
      insert into public.execution_events (organization_id, task_id, event_type, level, message)
      values (v_task.organization_id, v_task.id, 'task.paused', 'info', 'Task paused.');
      continue;
    end if;

    if v_attempt.id is null then
      if v_task.attempt_count >= v_task.max_attempts then
        update public.tasks
        set status = 'failed', lease_expires_at = null, completed_at = now(),
            error = jsonb_build_object('code', 'attempts_exhausted', 'class', 'transient',
              'message', 'The task failed on every attempt.')
        where id = v_task.id;
        insert into public.execution_events (organization_id, task_id, event_type, level, message)
        values (v_task.organization_id, v_task.id, 'task.failed', 'error', 'The task failed on every attempt.');
        continue;
      end if;
      insert into public.task_attempts (organization_id, task_id, attempt_number, status)
      values (v_task.organization_id, v_task.id, v_task.attempt_count + 1, 'running')
      returning * into v_attempt;
      v_new := true;
    end if;

    update public.tasks
    set status = 'running',
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        started_at = coalesce(started_at, now()),
        scheduled_at = null,
        attempt_count = case when v_new then attempt_count + 1 else attempt_count end
    where id = v_task.id;

    task_id := v_task.id;
    organization_id := v_task.organization_id;
    attempt_id := v_attempt.id;
    attempt_number := v_attempt.attempt_number;
    new_attempt := v_new;
    recovered := v_recovered;
    return next;
  end loop;
end;
$$;

create or replace function public.claim_workflow_runs(p_limit integer default 5, p_lease_seconds integer default 120, p_run_id uuid default null)
returns table (run_id uuid, organization_id uuid, lease_token uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_run public.workflow_runs%rowtype;
  v_token uuid;
begin
  if p_limit not between 1 and 50 or p_lease_seconds not between 10 and 3600 then
    raise exception 'invalid claim parameters' using errcode = '22023';
  end if;
  for v_run in
    select r.* from public.workflow_runs as r
    where r.status in ('queued', 'running', 'waiting')
      and (p_run_id is null or r.id = p_run_id)
      and (r.lease_expires_at is null or r.lease_expires_at < now())
      and (r.advance_requested_at is not null or r.wake_at <= now() or r.deadline_at <= now() or r.lease_expires_at < now())
      and not private.emergency_stopped(r.organization_id)
    order by coalesce(r.advance_requested_at, r.wake_at, r.deadline_at, r.queued_at), r.queued_at
    limit p_limit
    for update skip locked
  loop
    v_token := gen_random_uuid();
    update public.workflow_runs
    set lease_token = v_token, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        advance_requested_at = null, started_at = coalesce(started_at, now()),
        status = case when status = 'queued' then 'running' else status end
    where id = v_run.id;
    run_id := v_run.id;
    organization_id := v_run.organization_id;
    lease_token := v_token;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Revocation
-- ---------------------------------------------------------------------------

-- Cancels an employee's actions that wait on a tool it no longer has.
create function private.cancel_actions_without_grant(p_organization_id uuid, p_employee_id uuid, p_tool_key text, p_integration_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.approval_requests as a
  set status = 'cancelled', decided_at = now(), decision_note = 'The employee’s permission for this action was revoked.'
  from public.tool_executions as e
  where a.tool_execution_id = e.id and a.organization_id = p_organization_id and a.status = 'pending'
    and e.employee_id = p_employee_id and e.tool_key = p_tool_key
    and e.integration_id is not distinct from p_integration_id;
  update public.tool_executions
  set status = 'cancelled',
      error = jsonb_build_object('code', 'permission_revoked', 'message', 'The employee’s permission for this action was revoked.', 'retryable', false)
  where organization_id = p_organization_id and employee_id = p_employee_id and tool_key = p_tool_key
    and integration_id is not distinct from p_integration_id
    and status in ('proposed', 'awaiting_approval', 'approved');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Deferred so that re-granting in the same transaction (activating a new
-- version deletes and re-inserts every grant) cancels nothing.
create function private.revoke_grant_actions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.employee_tool_permissions := case when tg_op = 'DELETE' then old else new end;
  v_count integer;
begin
  if exists (
    select 1 from public.employee_tool_permissions as p
    where p.employee_id = v_row.employee_id and p.organization_id = v_row.organization_id
      and p.tool_key = v_row.tool_key and p.integration_id is not distinct from v_row.integration_id
      and p.decision <> 'deny'
  ) then
    return null;
  end if;
  v_count := private.cancel_actions_without_grant(v_row.organization_id, v_row.employee_id, v_row.tool_key, v_row.integration_id);
  if v_count > 0 then
    insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
    values (v_row.organization_id, case when auth.uid() is null then 'system' else 'user' end, auth.uid(),
      'employee.tool_actions_cancelled', 'ai_employees', v_row.employee_id::text,
      jsonb_build_object('tool_key', v_row.tool_key, 'cancelled_actions', v_count));
  end if;
  return null;
end;
$$;

create constraint trigger revoke_grant_actions
  after delete or update of decision on public.employee_tool_permissions
  deferrable initially deferred
  for each row execute function private.revoke_grant_actions();

-- Grants must stay inside the workspace's tool allowlists.
create function private.check_grant_allowed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.tool_allowed(new.organization_id, new.tool_key) then
    raise exception 'the workspace''s tool allowlist doesn''t include %', new.tool_key using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger check_grant_allowed before insert on public.employee_tool_permissions
  for each row execute function private.check_grant_allowed();

-- Disconnecting a connection (any path) cancels the actions waiting on it.
create function private.cancel_actions_of_revoked_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.approval_requests as a
  set status = 'cancelled', decided_at = now(), decision_note = 'The connection was disconnected.'
  from public.tool_executions as e
  where a.tool_execution_id = e.id and a.organization_id = new.organization_id and a.status = 'pending'
    and e.integration_id = new.id;
  update public.tool_executions
  set status = 'cancelled',
      error = jsonb_build_object('code', 'not_connected', 'message', 'The connection was disconnected.', 'retryable', false)
  where organization_id = new.organization_id and integration_id = new.id
    and status in ('proposed', 'awaiting_approval', 'approved');
  get diagnostics v_count = row_count;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (new.organization_id, case when auth.uid() is null then 'system' else 'user' end, auth.uid(),
    'integration.revoked', 'integrations', new.id::text,
    jsonb_build_object('provider', new.provider, 'cancelled_actions', v_count));
  return null;
end;
$$;

create trigger cancel_actions_of_revoked_connection
  after update of status on public.integrations
  for each row
  when (new.status = 'revoked' and old.status is distinct from 'revoked')
  execute function private.cancel_actions_of_revoked_connection();

create function public.revoke_employee_tool(p_employee_id uuid, p_tool_key text, p_integration_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_employee public.ai_employees%rowtype;
  v_deleted integer;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_employee from public.ai_employees as e where e.id = p_employee_id for update;
  if not found or not private.has_min_role(v_employee.organization_id, 'admin') then
    raise exception 'employee not found or role too low' using errcode = 'P0002';
  end if;
  delete from public.employee_tool_permissions as p
  where p.employee_id = v_employee.id and p.organization_id = v_employee.organization_id
    and p.tool_key = p_tool_key and p.integration_id is not distinct from p_integration_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'this employee doesn''t have that tool' using errcode = 'P0002';
  end if;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (v_employee.organization_id, 'user', v_uid, 'employee.tool_revoked', 'ai_employees', v_employee.id::text,
    jsonb_build_object('tool_key', p_tool_key, 'integration_id', p_integration_id));
  -- Waiting actions are cancelled by revoke_grant_actions when this commits.
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Emergency stop
-- ---------------------------------------------------------------------------

-- Pauses an employee's unfinished tasks (running ones after their current
-- step) and withdraws the actions waiting on approval.
create function private.halt_employee_work(p_organization_id uuid, p_employee_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_paused integer;
  v_stopping integer;
  v_withdrawn integer;
begin
  update public.tasks
  set pause_requested_at = coalesce(pause_requested_at, now()), emergency_paused_at = now()
  where organization_id = p_organization_id and employee_id is not null
    and (p_employee_id is null or employee_id = p_employee_id)
    and status = 'running' and cancel_requested_at is null;
  get diagnostics v_stopping = row_count;

  update public.tasks
  set status = 'paused', paused_from = status, paused_at = now(), emergency_paused_at = now()
  where organization_id = p_organization_id and employee_id is not null
    and (p_employee_id is null or employee_id = p_employee_id)
    and status in ('pending', 'queued', 'waiting_approval', 'blocked') and handed_off_at is null;
  get diagnostics v_paused = row_count;

  update public.approval_requests as a
  set status = 'cancelled', decided_at = now(), decided_by = p_user_id, decision_note = 'Withdrawn by an emergency stop.'
  from public.tool_executions as e
  where a.tool_execution_id = e.id and a.organization_id = p_organization_id and a.status = 'pending'
    and e.employee_id is not null and (p_employee_id is null or e.employee_id = p_employee_id);
  update public.tool_executions
  set status = 'cancelled',
      error = jsonb_build_object('code', 'emergency_stop', 'message', 'Withdrawn by an emergency stop.', 'retryable', false)
  where organization_id = p_organization_id and employee_id is not null
    and (p_employee_id is null or employee_id = p_employee_id)
    and status in ('proposed', 'awaiting_approval', 'approved');
  get diagnostics v_withdrawn = row_count;

  return jsonb_build_object('paused_tasks', v_paused, 'stopping_tasks', v_stopping, 'withdrawn_actions', v_withdrawn);
end;
$$;

create function public.set_emergency_stop(p_organization_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_run public.workflow_runs%rowtype;
  v_runs integer := 0;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not private.has_min_role(p_organization_id, 'admin') then
    raise exception 'workspace not found or role too low' using errcode = 'P0002';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 or private.text_contains_secret(p_reason) then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  if private.emergency_stopped(p_organization_id) then
    raise exception 'the emergency stop is already active' using errcode = '55000';
  end if;

  insert into public.organization_governance (organization_id, emergency_stop_at, emergency_stop_by, emergency_stop_reason, updated_by)
  values (p_organization_id, now(), v_uid, btrim(p_reason), v_uid)
  on conflict (organization_id) do update
  set emergency_stop_at = excluded.emergency_stop_at, emergency_stop_by = excluded.emergency_stop_by,
      emergency_stop_reason = excluded.emergency_stop_reason, updated_by = excluded.updated_by;

  -- Workflow runs are cancelled (they hold steps and gates that can't wait out a stop).
  for v_run in
    select r.* from public.workflow_runs as r
    where r.organization_id = p_organization_id and r.status in ('queued', 'running', 'waiting')
    for update
  loop
    update public.workflow_runs
    set status = 'cancelled', cancel_requested_at = now(), finished_at = now(), started_at = coalesce(started_at, now()),
        lease_token = null, lease_expires_at = null, advance_requested_at = null, wake_at = null,
        summary = 'Cancelled by an emergency stop.'
    where id = v_run.id;
    perform private.stop_workflow_run_work(v_run.id, v_run.organization_id, v_uid);
    insert into public.execution_events (organization_id, workflow_run_id, event_type, level, message)
    values (v_run.organization_id, v_run.id, 'run.cancelled', 'warn', 'Cancelled by an emergency stop.');
    v_runs := v_runs + 1;
  end loop;

  v_result := private.halt_employee_work(p_organization_id, null, v_uid) || jsonb_build_object('cancelled_runs', v_runs);

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, 'user', v_uid, 'governance.emergency_stop', 'organization_governance', p_organization_id::text,
    v_result || jsonb_build_object('reason', btrim(p_reason)));
  return v_result;
end;
$$;

create function public.lift_emergency_stop(p_organization_id uuid, p_resume_tasks boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_status text;
  v_resumed integer := 0;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not private.has_min_role(p_organization_id, 'admin') then
    raise exception 'workspace not found or role too low' using errcode = 'P0002';
  end if;
  if not private.emergency_stopped(p_organization_id) then
    raise exception 'the emergency stop isn''t active' using errcode = '55000';
  end if;

  update public.organization_governance
  set emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null, updated_by = v_uid
  where organization_id = p_organization_id;

  if p_resume_tasks then
    for v_task in
      select t.* from public.tasks as t
      join public.ai_employees as e on e.id = t.employee_id and e.organization_id = t.organization_id
      where t.organization_id = p_organization_id and t.emergency_paused_at is not null
        and t.status = 'paused' and e.status = 'active'
      for update of t
    loop
      v_status := case v_task.paused_from
        when 'pending' then case when private.task_dependencies_met(v_task.id) then 'queued' else 'pending' end
        when 'blocked' then 'blocked'
        when 'waiting_approval' then case when exists (
            select 1 from public.tool_executions as x
            where x.task_id = v_task.id and x.status in ('proposed', 'awaiting_approval', 'approved', 'executing')
          ) then 'waiting_approval' else 'queued' end
        else 'queued'
      end;
      update public.tasks
      set status = v_status, paused_at = null, paused_from = null, pause_requested_at = null, scheduled_at = null,
          emergency_paused_at = null
      where id = v_task.id;
      insert into public.execution_events (organization_id, task_id, event_type, level, message)
      values (v_task.organization_id, v_task.id, 'task.resumed', 'info', 'Resumed after the emergency stop was lifted.');
      v_resumed := v_resumed + 1;
    end loop;
  end if;
  update public.tasks set emergency_paused_at = null
  where organization_id = p_organization_id and emergency_paused_at is not null and status <> 'paused' and status <> 'running';

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, 'user', v_uid, 'governance.emergency_stop_lifted', 'organization_governance', p_organization_id::text,
    jsonb_build_object('resumed_tasks', v_resumed));
  return jsonb_build_object('resumed_tasks', v_resumed);
end;
$$;

-- Stops one employee now: paused, its tasks paused, its waiting actions withdrawn.
create function public.emergency_stop_employee(p_employee_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_employee public.ai_employees%rowtype;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_employee from public.ai_employees as e where e.id = p_employee_id for update;
  if not found or not private.has_min_role(v_employee.organization_id, 'operator') then
    raise exception 'employee not found or role too low' using errcode = 'P0002';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 or private.text_contains_secret(p_reason) then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  if v_employee.status = 'active' then
    update public.ai_employees set status = 'paused' where id = v_employee.id;
  end if;
  v_result := private.halt_employee_work(v_employee.organization_id, v_employee.id, v_uid);
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (v_employee.organization_id, 'user', v_uid, 'employee.emergency_stop', 'ai_employees', v_employee.id::text,
    v_result || jsonb_build_object('reason', btrim(p_reason), 'previous_status', v_employee.status));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Human handoff
-- ---------------------------------------------------------------------------

create function public.hand_off_employee_task(p_task_id uuid, p_assignee uuid default null, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype := private.operator_task(p_task_id);
  v_assignee uuid := coalesce(p_assignee, auth.uid());
  v_withdrawn integer;
begin
  if v_task.handed_off_at is not null then
    raise exception 'a person already took over this task' using errcode = '55000';
  end if;
  if v_task.status = 'running' then
    raise exception 'pause the task first; it hands over once its current step ends' using errcode = '55000';
  end if;
  if v_task.status not in ('pending', 'queued', 'waiting_approval', 'blocked', 'paused') then
    raise exception 'only an unfinished task can be handed over' using errcode = '55000';
  end if;
  if not private.user_has_min_role(v_task.organization_id, v_assignee, 'operator') then
    raise exception 'the person taking over must be an operator or above in this workspace' using errcode = '22023';
  end if;
  if p_note is not null and (char_length(p_note) > 2000 or private.text_contains_secret(p_note)) then
    raise exception 'the note is too long or looks like it contains a credential' using errcode = '22023';
  end if;

  v_withdrawn := private.withdraw_task_actions(v_task.id, v_task.organization_id, auth.uid());
  update public.tasks
  set status = 'blocked', paused_at = null, paused_from = null, pause_requested_at = null, emergency_paused_at = null,
      lease_expires_at = null, scheduled_at = null,
      handed_off_to = v_assignee, handed_off_by = auth.uid(), handed_off_at = now(), handoff_note = p_note
  where id = v_task.id;
  perform private.record_task_control(v_task, 'task.handed_off', 'A person took over this task.', 'task.handed_off',
    jsonb_build_object('to', v_assignee, 'withdrawn_actions', v_withdrawn));
  return 'handed_off';
end;
$$;

create function public.complete_handed_off_task(p_task_id uuid, p_outcome text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype := private.operator_task(p_task_id);
  v_uid uuid := auth.uid();
begin
  if v_task.handed_off_at is null or v_task.status <> 'blocked' then
    raise exception 'only a task a person took over can be completed this way' using errcode = '55000';
  end if;
  if v_task.handed_off_to is distinct from v_uid and not private.has_min_role(v_task.organization_id, 'admin') then
    raise exception 'only the person who took over the task, or an admin, can complete it' using errcode = '42501';
  end if;
  if p_outcome not in ('done', 'cancelled') then
    raise exception 'outcome must be done or cancelled' using errcode = '22023';
  end if;
  if p_note is not null and (char_length(p_note) > 2000 or private.text_contains_secret(p_note)) then
    raise exception 'the note is too long or looks like it contains a credential' using errcode = '22023';
  end if;
  update public.tasks
  set status = case when p_outcome = 'done' then 'succeeded' else 'cancelled' end,
      completed_at = now(),
      result = coalesce(result, '{}'::jsonb) || jsonb_build_object('handoff', jsonb_build_object(
        'completedBy', v_uid, 'outcome', p_outcome, 'note', p_note, 'completedAt', now()))
  where id = v_task.id;
  perform private.record_task_control(v_task, 'task.completed_by_person',
    case when p_outcome = 'done' then 'A person completed this task.' else 'A person closed this task without completing it.' end,
    'task.completed_by_person', jsonb_build_object('outcome', p_outcome));
  return case when p_outcome = 'done' then 'succeeded' else 'cancelled' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Evidence retention
-- ---------------------------------------------------------------------------

create function public.set_retention_settings(
  p_organization_id uuid,
  p_evidence_days integer,
  p_event_days integer,
  p_payload_days integer,
  p_hold boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not private.has_min_role(p_organization_id, 'admin') then
    raise exception 'workspace not found or role too low' using errcode = 'P0002';
  end if;
  insert into public.organization_governance (organization_id, evidence_retention_days, event_retention_days, payload_retention_days, retention_hold, updated_by)
  values (p_organization_id, p_evidence_days, p_event_days, p_payload_days, coalesce(p_hold, false), v_uid)
  on conflict (organization_id) do update
  set evidence_retention_days = excluded.evidence_retention_days, event_retention_days = excluded.event_retention_days,
      payload_retention_days = excluded.payload_retention_days, retention_hold = excluded.retention_hold,
      updated_by = excluded.updated_by;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, 'user', v_uid, 'governance.retention_changed', 'organization_governance', p_organization_id::text,
    jsonb_build_object('evidence_days', p_evidence_days, 'event_days', p_event_days, 'payload_days', p_payload_days, 'hold', coalesce(p_hold, false)));
end;
$$;

-- Deletes evidence and events, and clears action payloads, past each
-- workspace's retention (unfinished work and held workspaces are skipped).
-- Fingerprints, statuses, decisions and the audit log are kept.
create function public.purge_expired_task_data(p_limit integer default 5000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.organization_governance%rowtype;
  v_evidence integer;
  v_events integer;
  v_payloads integer;
  v_approvals integer;
  v_total jsonb := '{}'::jsonb;
begin
  if p_limit not between 1 and 100000 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  perform set_config('nexefiy.retention_purge', 'on', true);
  for v_settings in
    select g.* from public.organization_governance as g
    where not g.retention_hold
      and (g.evidence_retention_days is not null or g.event_retention_days is not null or g.payload_retention_days is not null)
  loop
    v_evidence := 0; v_events := 0; v_payloads := 0; v_approvals := 0;
    if v_settings.evidence_retention_days is not null then
      delete from public.task_evidence as d
      where d.id in (
        select v.id from public.task_evidence as v
        join public.tasks as t on t.id = v.task_id and t.organization_id = v.organization_id
        where v.organization_id = v_settings.organization_id
          and v.created_at < now() - make_interval(days => v_settings.evidence_retention_days)
          and t.status in ('succeeded', 'failed', 'cancelled', 'skipped')
        limit p_limit
      );
      get diagnostics v_evidence = row_count;
    end if;
    if v_settings.event_retention_days is not null then
      delete from public.execution_events as d
      where d.id in (
        select v.id from public.execution_events as v
        where v.organization_id = v_settings.organization_id
          and v.created_at < now() - make_interval(days => v_settings.event_retention_days)
        limit p_limit
      );
      get diagnostics v_events = row_count;
    end if;
    if v_settings.payload_retention_days is not null then
      update public.tool_executions as e
      set input_redacted = '{}'::jsonb, output_redacted = null, payload_purged_at = now()
      where e.id in (
        select x.id from public.tool_executions as x
        where x.organization_id = v_settings.organization_id and x.payload_purged_at is null
          and x.finished_at is not null
          and x.finished_at < now() - make_interval(days => v_settings.payload_retention_days)
        limit p_limit
      );
      get diagnostics v_payloads = row_count;
      update public.approval_requests as a
      set proposed_action = jsonb_build_object('purged', true, 'action', a.proposed_action -> 'action',
        'actionTitle', a.proposed_action -> 'actionTitle')
      where a.id in (
        select r.id from public.approval_requests as r
        where r.organization_id = v_settings.organization_id and r.status <> 'pending'
          and not (r.proposed_action ? 'purged')
          and r.decided_at < now() - make_interval(days => v_settings.payload_retention_days)
        limit p_limit
      );
      get diagnostics v_approvals = row_count;
    end if;
    update public.organization_governance set last_purged_at = now() where organization_id = v_settings.organization_id;
    if v_evidence + v_events + v_payloads + v_approvals > 0 then
      insert into public.audit_logs (organization_id, actor_type, action, target_table, target_id, metadata)
      values (v_settings.organization_id, 'system', 'governance.retention_purged', 'organization_governance',
        v_settings.organization_id::text,
        jsonb_build_object('evidence', v_evidence, 'events', v_events, 'payloads', v_payloads, 'approvals', v_approvals));
    end if;
    v_total := v_total || jsonb_build_object(v_settings.organization_id::text,
      jsonb_build_object('evidence', v_evidence, 'events', v_events, 'payloads', v_payloads, 'approvals', v_approvals));
  end loop;
  perform set_config('nexefiy.retention_purge', 'off', true);
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Row Level Security and privileges
-- ---------------------------------------------------------------------------

alter table public.organization_policy_versions enable row level security;
alter table public.organization_governance enable row level security;

revoke all on public.organization_policy_versions, public.organization_governance from anon, authenticated;
grant select on public.organization_policy_versions, public.organization_governance to authenticated;

create policy "organization_policy_versions: members read" on public.organization_policy_versions
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "organization_governance: members read" on public.organization_governance
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

-- Authorization columns are written by the trigger only.
revoke insert, update on public.organization_policies from authenticated;
grant insert (organization_id, name, description, policy_schema_version, policy, priority, enabled)
  on public.organization_policies to authenticated;
grant update (name, description, policy_schema_version, policy, priority, enabled)
  on public.organization_policies to authenticated;

revoke all on function
  private.stamp_policy_authorization(),
  private.record_policy_version(),
  private.tool_allowed(uuid, text),
  private.emergency_stopped(uuid),
  private.guard_task_governance(),
  private.guard_execution_governance(),
  private.cancel_actions_without_grant(uuid, uuid, text, uuid),
  private.revoke_grant_actions(),
  private.check_grant_allowed(),
  private.cancel_actions_of_revoked_connection(),
  private.halt_employee_work(uuid, uuid, uuid)
from public, anon, authenticated;

revoke all on function
  public.set_emergency_stop(uuid, text),
  public.lift_emergency_stop(uuid, boolean),
  public.emergency_stop_employee(uuid, text),
  public.revoke_employee_tool(uuid, text, uuid),
  public.hand_off_employee_task(uuid, uuid, text),
  public.complete_handed_off_task(uuid, text, text),
  public.set_retention_settings(uuid, integer, integer, integer, boolean),
  public.purge_expired_task_data(integer)
from public, anon;

grant execute on function
  public.set_emergency_stop(uuid, text),
  public.lift_emergency_stop(uuid, boolean),
  public.emergency_stop_employee(uuid, text),
  public.revoke_employee_tool(uuid, text, uuid),
  public.hand_off_employee_task(uuid, uuid, text),
  public.complete_handed_off_task(uuid, text, text),
  public.set_retention_settings(uuid, integer, integer, integer, boolean)
to authenticated;

revoke all on function public.purge_expired_task_data(integer) from authenticated;
grant execute on function public.purge_expired_task_data(integer) to service_role;

-- The claim functions (service role) ask whether a workspace is stopped.
grant execute on function private.emergency_stopped(uuid), private.tool_allowed(uuid, text) to service_role;

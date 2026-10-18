-- Governance: organization policies, approval requests bound to the exact
-- proposed action, and an append-only audit log.

create table public.organization_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (char_length(description) <= 2000),
  policy_schema_version integer not null default 1,
  policy jsonb not null,
  priority integer not null default 100 check (priority between 0 and 10000),
  enabled boolean not null default true,
  -- Incremented whenever the policy document changes; approvals record it.
  revision integer not null default 1 check (revision >= 1),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, name),
  constraint organization_policies_document_valid
    check (private.policy_document_is_valid(policy_schema_version, policy)),
  constraint organization_policies_document_has_no_secrets
    check (not private.jsonb_contains_secret(policy))
);

create index organization_policies_org_idx on public.organization_policies (organization_id, enabled, priority);

alter table public.tool_executions
  add constraint tool_executions_policy_fk
  foreign key (policy_id, organization_id)
  references public.organization_policies (id, organization_id) on delete set null (policy_id);
create index tool_executions_policy_idx on public.tool_executions (policy_id) where policy_id is not null;

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  tool_execution_id uuid not null unique,
  task_id uuid not null,
  workflow_run_id uuid,
  employee_id uuid,
  -- Versions of the configuration that proposed the action.
  employee_version_id uuid,
  workflow_version_id uuid,
  policy_id uuid,
  policy_revision integer check (policy_revision >= 1),
  action_summary text not null check (char_length(btrim(action_summary)) between 1 and 1000),
  -- Redacted view of the proposed action shown to approvers.
  proposed_action jsonb not null
    check (jsonb_typeof(proposed_action) = 'object' and not private.jsonb_contains_secret(proposed_action)),
  -- Fingerprint of the exact action; must equal tool_executions.input_sha256.
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  required_role text not null default 'operator' check (required_role in ('owner', 'admin', 'operator')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 2000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tool_execution_id, organization_id)
    references public.tool_executions (id, organization_id) on delete cascade,
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete cascade,
  foreign key (workflow_run_id, organization_id)
    references public.workflow_runs (id, organization_id) on delete cascade,
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete set null (employee_id),
  foreign key (employee_version_id, organization_id)
    references public.employee_versions (id, organization_id) on delete set null (employee_version_id),
  foreign key (workflow_version_id, organization_id)
    references public.workflow_versions (id, organization_id) on delete set null (workflow_version_id),
  foreign key (policy_id, organization_id)
    references public.organization_policies (id, organization_id) on delete set null (policy_id),
  check (expires_at > created_at),
  check ((status = 'pending') = (decided_at is null))
);

create index approval_requests_org_pending_idx on public.approval_requests (organization_id, expires_at)
  where status = 'pending';
create index approval_requests_org_created_idx on public.approval_requests (organization_id, created_at desc);
create index approval_requests_task_idx on public.approval_requests (task_id);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  -- No foreign keys on purpose: audit records outlive the organizations,
  -- users, and rows they describe.
  organization_id uuid,
  actor_type text not null check (actor_type in ('user', 'employee', 'system', 'service')),
  actor_user_id uuid,
  actor_employee_id uuid,
  action text not null check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$'),
  target_table text check (char_length(target_table) <= 63),
  target_id text check (char_length(target_id) <= 200),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and not private.jsonb_contains_secret(metadata)),
  occurred_at timestamptz not null default now()
);

create index audit_logs_org_idx on public.audit_logs (organization_id, occurred_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_user_id, occurred_at desc) where actor_user_id is not null;

create trigger set_updated_at before update on public.organization_policies
  for each row execute function private.set_updated_at();
create trigger stamp_updated_by before update on public.organization_policies
  for each row execute function private.stamp_updated_by();
create trigger set_updated_at before update on public.approval_requests
  for each row execute function private.set_updated_at();

create function private.bump_policy_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.policy is distinct from old.policy or new.policy_schema_version <> old.policy_schema_version then
    new.revision := old.revision + 1;
  else
    new.revision := old.revision;
  end if;
  return new;
end;
$$;

create trigger bump_policy_revision before update on public.organization_policies
  for each row execute function private.bump_policy_revision();

-- ---------------------------------------------------------------------------
-- Approvals bind to the exact action
-- ---------------------------------------------------------------------------

create function private.guard_approval_request()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_execution public.tool_executions;
begin
  if tg_op = 'INSERT' then
    select * into v_execution from public.tool_executions as e where e.id = new.tool_execution_id;
    if v_execution.input_sha256 <> new.payload_sha256
       or v_execution.task_id <> new.task_id
       or v_execution.policy_decision <> 'require_approval'
       or v_execution.status <> 'awaiting_approval' then
      raise exception 'an approval request must match a tool execution that is awaiting approval'
        using errcode = '23514';
    end if;
    if new.status <> 'pending' then
      raise exception 'approval requests start as pending' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.organization_id <> old.organization_id
     or new.tool_execution_id <> old.tool_execution_id
     or new.task_id <> old.task_id
     or new.payload_sha256 <> old.payload_sha256
     or new.proposed_action <> old.proposed_action
     or new.action_summary <> old.action_summary
     or new.required_role <> old.required_role
     or new.expires_at <> old.expires_at then
    raise exception 'the proposed action of an approval request cannot be changed' using errcode = '42501';
  end if;
  if old.status <> 'pending' and new.status <> old.status then
    raise exception 'approval request is already %', old.status using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger guard_approval_request before insert or update on public.approval_requests
  for each row execute function private.guard_approval_request();

-- A tool execution that needs approval can only start with an approval for
-- this exact payload fingerprint.
create function private.require_approval_to_execute()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.policy_decision = 'require_approval'
     and new.status in ('executing', 'succeeded')
     and old.status is distinct from new.status
     and not exists (
       select 1 from public.approval_requests as a
       where a.tool_execution_id = new.id
         and a.status = 'approved'
         and a.payload_sha256 = new.input_sha256
     ) then
    raise exception 'this tool execution requires an approved approval request for its exact payload'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger require_approval_to_execute before update on public.tool_executions
  for each row execute function private.require_approval_to_execute();

-- ---------------------------------------------------------------------------
-- Audit log: append-only, written by triggers
-- ---------------------------------------------------------------------------

create function private.prevent_audit_log_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only private.purge_audit_logs() (retention) may delete, never update.
  if tg_op = 'DELETE' and current_setting('nexefiy.audit_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'audit_logs is append-only' using errcode = '42501';
end;
$$;

create trigger prevent_audit_log_change before update or delete on public.audit_logs
  for each row execute function private.prevent_audit_log_change();

create function private.purge_audit_logs(p_before timestamptz)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  if p_before > now() - interval '365 days' then
    raise exception 'audit logs must be kept for at least 365 days' using errcode = '22023';
  end if;
  perform set_config('nexefiy.audit_purge', 'on', true);
  delete from public.audit_logs where occurred_at < p_before;
  get diagnostics v_deleted = row_count;
  perform set_config('nexefiy.audit_purge', 'off', true);
  return v_deleted;
end;
$$;

revoke all on function private.purge_audit_logs(timestamptz) from public, anon, authenticated;
grant execute on function private.purge_audit_logs(timestamptz) to service_role;

-- Records who changed what. Stores column names and a small allow-list of
-- non-sensitive values (roles, statuses, flags) — never full rows.
create function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_tracked text[] := array['role', 'status', 'enabled', 'decision', 'approval_mode', 'risk_level',
    'required_role', 'trigger_type', 'plan_key', 'provider', 'tool_key', 'version', 'revision'];
  v_changed text[];
  v_meta jsonb := '{}'::jsonb;
  v_key text;
  v_actor uuid := (select auth.uid());
begin
  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into v_changed
    from jsonb_each(v_new) as n
    where n.key not in ('updated_at', 'updated_by', 'lock_version')
      and n.value is distinct from v_old -> n.key;
    if v_changed is null then
      return null;
    end if;
    v_meta := jsonb_build_object('changed_columns', to_jsonb(v_changed));
    foreach v_key in array v_tracked loop
      if v_key = any (v_changed) then
        v_meta := v_meta || jsonb_build_object(v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key));
      end if;
    end loop;
  else
    foreach v_key in array v_tracked loop
      if v_row ? v_key then
        v_meta := v_meta || jsonb_build_object(v_key, v_row -> v_key);
      end if;
    end loop;
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (
    case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid else (v_row ->> 'organization_id')::uuid end,
    case
      when v_actor is not null then 'user'
      when coalesce(auth.role(), '') = 'service_role' then 'service'
      else 'system'
    end,
    v_actor,
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'integration_id', v_row ->> 'organization_id'),
    v_meta
  );
  return null;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'organizations', 'organization_members', 'organization_invitations', 'company_settings',
    'ai_employees', 'employee_versions', 'employee_tool_permissions',
    'integrations', 'integration_actions', 'integration_secrets',
    'workflow_definitions', 'workflow_versions', 'workflow_triggers',
    'organization_policies', 'approval_requests'
  ] loop
    execute format(
      'create trigger audit_row_change after insert or update or delete on public.%I
         for each row execute function private.audit_row_change()',
      v_table
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- ---------------------------------------------------------------------------

alter table public.organization_policies enable row level security;
alter table public.approval_requests enable row level security;
alter table public.audit_logs enable row level security;

revoke all on public.organization_policies, public.approval_requests, public.audit_logs
from anon, authenticated;

-- organization_policies: members read (the UI explains why actions need approval); admins manage.
grant select, delete on public.organization_policies to authenticated;
grant insert (organization_id, name, description, policy_schema_version, policy, priority, enabled)
  on public.organization_policies to authenticated;
grant update (name, description, policy_schema_version, policy, priority, enabled)
  on public.organization_policies to authenticated;

create policy "organization_policies: members read" on public.organization_policies
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "organization_policies: admins create" on public.organization_policies
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "organization_policies: admins update" on public.organization_policies
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')))
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "organization_policies: admins delete" on public.organization_policies
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

-- approval_requests: members read; decisions only through public.decide_approval().
grant select on public.approval_requests to authenticated;

create policy "approval_requests: members read" on public.approval_requests
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

-- audit_logs: owners and admins read; nobody writes directly.
grant select on public.audit_logs to authenticated;

create policy "audit_logs: admins read" on public.audit_logs
  for select to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

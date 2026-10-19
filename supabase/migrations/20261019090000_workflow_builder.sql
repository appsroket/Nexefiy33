-- Workflow builder: drafts, validated immutable versions, and controlled runs.
--
--   * graph schema version 2: trigger, employee task, tool action, condition,
--     approval, data transformation, delay and end steps; inputs; branches;
--     settings. The database checks the outline (shape, ids, connections, one
--     trigger, no cycles); the server checks steps, references, resources,
--     permissions and policies before activating (src/modules/workflows).
--   * drafts are edited under the editor's own session with optimistic
--     locking; only never-activated workflows can be deleted.
--   * activation (publish_workflow_version, service role, called by the
--     server after validation) is for admins, confirmed by typing the name,
--     and creates an immutable version; runs pin the exact version.
--   * runs: start (operators, inputs checked against the version), cancel,
--     scheduled starts; steps recorded in workflow_run_steps. The server's
--     orchestrator claims a run under a lease, advances it, and records its
--     progress only while it still holds the lease.
--   * every step that does work is a task: employee steps are employee tasks
--     (the task runtime runs them), tool actions and approval gates are tasks
--     without an employee. A task changing state wakes its run.
--   * approval gates are approval requests of kind "workflow_gate", bound to
--     the exact text the approver sees, decided through decide_approval.

-- ---------------------------------------------------------------------------
-- 1. Graph schema version 2
-- ---------------------------------------------------------------------------

create function private.workflow_graph_v1_is_valid(p_graph jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when not extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "required": ["nodes", "edges"],
        "properties": {
          "nodes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 200,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "type"],
              "properties": {
                "id": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
                "type": { "enum": ["employee_task", "tool_action", "condition", "approval", "delay"] },
                "label": { "type": "string", "maxLength": 200 },
                "config": { "type": "object" }
              }
            }
          },
          "edges": {
            "type": "array",
            "maxItems": 500,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["source", "target"],
              "properties": {
                "id": { "type": "string", "maxLength": 64 },
                "source": { "type": "string" },
                "target": { "type": "string" },
                "condition": { "enum": ["true", "false", "approved", "rejected", "expired"] }
              }
            }
          },
          "settings": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "maxRunMinutes": { "type": "integer", "minimum": 1, "maximum": 10080 },
              "maxCostUsd": { "type": "number", "exclusiveMinimum": 0 },
              "onFailure": { "enum": ["stop", "notify"] }
            }
          }
        }
      }$schema$::json,
      p_graph
    ) then false
    else (
      select count(*) = count(distinct n.value ->> 'id')
      from jsonb_array_elements(p_graph -> 'nodes') as n
    ) and not exists (
      select 1
      from jsonb_array_elements(p_graph -> 'edges') as e
      where not exists (select 1 from jsonb_array_elements(p_graph -> 'nodes') as n where n.value ->> 'id' = e.value ->> 'source')
         or not exists (select 1 from jsonb_array_elements(p_graph -> 'nodes') as n where n.value ->> 'id' = e.value ->> 'target')
    )
  end;
$$;

create function private.workflow_graph_v2_is_valid(p_graph jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when not extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "required": ["inputs", "nodes", "edges", "settings"],
        "properties": {
          "inputs": {
            "type": "array",
            "maxItems": 20,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["key", "label", "type", "required"],
              "properties": {
                "key": { "type": "string", "pattern": "^[a-z][a-zA-Z0-9_]{0,39}$" },
                "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                "type": { "enum": ["text", "long_text", "number", "boolean", "email"] },
                "required": { "type": "boolean" },
                "description": { "type": "string", "maxLength": 300 }
              }
            }
          },
          "nodes": {
            "type": "array",
            "minItems": 2,
            "maxItems": 50,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "type", "label", "config"],
              "properties": {
                "id": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
                "type": { "enum": ["trigger", "employee_task", "tool_action", "condition", "approval", "transform", "delay", "end"] },
                "label": { "type": "string", "maxLength": 80 },
                "config": { "type": "object" }
              }
            }
          },
          "edges": {
            "type": "array",
            "maxItems": 100,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "source", "target"],
              "properties": {
                "id": { "type": "string", "minLength": 1, "maxLength": 64 },
                "source": { "type": "string" },
                "target": { "type": "string" },
                "branch": { "enum": ["true", "false", "approved", "rejected", "failure"] }
              }
            }
          },
          "settings": {
            "type": "object",
            "additionalProperties": false,
            "required": ["maxRunMinutes", "maxCostUsd"],
            "properties": {
              "maxRunMinutes": { "type": "integer", "minimum": 5, "maximum": 10080 },
              "maxCostUsd": { "type": ["number", "null"], "exclusiveMinimum": 0, "maximum": 1000 }
            }
          }
        }
      }$schema$::json,
      p_graph
    ) then false
    -- Unique ids, exactly one trigger with nothing leading into it, at least one end.
    when (select count(*) <> count(distinct n.value ->> 'id') from jsonb_array_elements(p_graph -> 'nodes') as n) then false
    when (select count(*) <> 1 from jsonb_array_elements(p_graph -> 'nodes') as n where n.value ->> 'type' = 'trigger') then false
    when not exists (select 1 from jsonb_array_elements(p_graph -> 'nodes') as n where n.value ->> 'type' = 'end') then false
    -- Every connection joins two different existing steps, never into the trigger or out of an end.
    when exists (
      select 1
      from jsonb_array_elements(p_graph -> 'edges') as e
      left join jsonb_array_elements(p_graph -> 'nodes') as s on s.value ->> 'id' = e.value ->> 'source'
      left join jsonb_array_elements(p_graph -> 'nodes') as t on t.value ->> 'id' = e.value ->> 'target'
      where s.value is null or t.value is null
         or e.value ->> 'source' = e.value ->> 'target'
         or t.value ->> 'type' = 'trigger'
         or s.value ->> 'type' = 'end'
    ) then false
    -- No cycles.
    else not exists (
      with recursive walk (start_id, node_id) as (
        select e.value ->> 'source', e.value ->> 'target'
        from jsonb_array_elements(p_graph -> 'edges') as e
        union
        select w.start_id, e.value ->> 'target'
        from walk as w
        join jsonb_array_elements(p_graph -> 'edges') as e on e.value ->> 'source' = w.node_id
        where w.node_id <> w.start_id
      )
      select 1 from walk where node_id = start_id
    )
  end;
$$;

create or replace function private.workflow_graph_is_valid(p_schema_version integer, p_graph jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_schema_version
    when 1 then private.workflow_graph_v1_is_valid(p_graph)
    when 2 then private.workflow_graph_v2_is_valid(p_graph)
    else false
  end;
$$;

grant execute on function private.workflow_graph_v1_is_valid(jsonb), private.workflow_graph_v2_is_valid(jsonb)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Drafts and versions
-- ---------------------------------------------------------------------------

alter table public.workflow_definitions
  -- Node positions on the canvas; kept apart from the graph so moving a step
  -- never changes what the workflow does.
  add column draft_layout jsonb not null default '{}'::jsonb
    check (jsonb_typeof(draft_layout) = 'object' and pg_column_size(draft_layout) <= 65536),
  add column draft_source text not null default 'manual'
    check (draft_source in ('manual', 'ai_generated', 'rules', 'template', 'imported')),
  -- How the draft was generated (model, prompt size, validation, repairs); never the prompt's secrets.
  add column draft_generation jsonb
    check (draft_generation is null or (jsonb_typeof(draft_generation) = 'object' and not private.jsonb_contains_secret(draft_generation))),
  -- The last validation report shown to the editor (informational: activation validates again).
  add column draft_validation jsonb check (draft_validation is null or jsonb_typeof(draft_validation) = 'object'),
  add column activated_at timestamptz,
  add column activated_by uuid references auth.users (id) on delete set null,
  add constraint workflow_definitions_draft_size check (pg_column_size(draft_graph) <= 262144);

create index workflow_definitions_activated_by_idx on public.workflow_definitions (activated_by) where activated_by is not null;

alter table public.workflow_versions
  add column layout jsonb not null default '{}'::jsonb check (jsonb_typeof(layout) = 'object'),
  drop constraint workflow_versions_source_check,
  add constraint workflow_versions_source_check check (source in ('manual', 'ai_generated', 'rules', 'template', 'imported'));

-- Scheduled triggers belong to the version that registered them.
alter table public.workflow_triggers
  add column workflow_version_id uuid,
  add constraint workflow_triggers_version_fk foreign key (workflow_version_id, workflow_id)
    references public.workflow_versions (id, workflow_id) on delete cascade;
create index workflow_triggers_version_idx on public.workflow_triggers (workflow_version_id) where workflow_version_id is not null;

-- Editors change drafts only; status and the current version change through the functions below.
revoke insert, update on public.workflow_definitions from authenticated;
grant insert (organization_id, name, description, draft_schema_version, draft_graph, draft_layout, draft_source,
  draft_generation, draft_validation)
  on public.workflow_definitions to authenticated;
grant update (name, description, draft_schema_version, draft_graph, draft_layout, draft_source, draft_generation,
  draft_validation)
  on public.workflow_definitions to authenticated;

-- A workflow that was ever activated keeps its history (versions, runs); archive it instead.
drop policy "workflow_definitions: operators delete" on public.workflow_definitions;
create policy "workflow_definitions: operators delete never-activated drafts" on public.workflow_definitions
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')) and current_version_id is null);

-- Triggers are registered by activation, not edited by clients.
revoke insert, update, delete on public.workflow_triggers from authenticated;
drop policy "workflow_triggers: operators create" on public.workflow_triggers;
drop policy "workflow_triggers: operators update" on public.workflow_triggers;
drop policy "workflow_triggers: operators delete" on public.workflow_triggers;

-- ---------------------------------------------------------------------------
-- 3. Runs and steps
-- ---------------------------------------------------------------------------

alter table public.workflow_runs
  -- The orchestrator's lease: every write it makes is conditional on the token.
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  -- Set when something the run waits on changed; the next claim advances it.
  add column advance_requested_at timestamptz,
  -- The earliest time a waiting step (a delay, a retry) is due.
  add column wake_at timestamptz,
  add column deadline_at timestamptz,
  -- The admin who activated the version; the run acts on their authority and stops if they lose it.
  add column authorized_by uuid references auth.users (id) on delete set null,
  add column summary text check (char_length(summary) <= 4000 and not private.text_contains_secret(summary)),
  add column output jsonb check (output is null or (jsonb_typeof(output) = 'object' and not private.jsonb_contains_secret(output))),
  add constraint workflow_runs_lease_pair check ((lease_token is null) = (lease_expires_at is null)),
  add constraint workflow_runs_no_lease_when_finished
    check (lease_token is null or status not in ('succeeded', 'failed', 'cancelled', 'rejected', 'timed_out'));

create index workflow_runs_due_idx on public.workflow_runs (advance_requested_at, wake_at, deadline_at)
  where status in ('queued', 'running', 'waiting');
create index workflow_runs_authorized_by_idx on public.workflow_runs (authorized_by) where authorized_by is not null;
create index workflow_runs_created_by_idx on public.workflow_runs (created_by) where created_by is not null;

create table public.workflow_run_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  node_id text not null check (node_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  node_type text not null
    check (node_type in ('trigger', 'employee_task', 'tool_action', 'condition', 'approval', 'transform', 'delay', 'end')),
  label text check (char_length(label) <= 80),
  status text not null check (status in ('running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled')),
  -- The path the step took: a condition's or approval's outcome, or "failure".
  branch text check (branch in ('true', 'false', 'approved', 'rejected', 'failure')),
  attempt smallint not null default 0 check (attempt between 0 and 20),
  -- The task doing the step's work (employee task, tool action, approval gate).
  task_id uuid,
  due_at timestamptz,
  input jsonb check (input is null or (jsonb_typeof(input) = 'object' and not private.jsonb_contains_secret(input))),
  output jsonb check (output is null or not private.jsonb_contains_secret(output)),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (run_id, organization_id) references public.workflow_runs (id, organization_id) on delete cascade,
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete set null (task_id),
  unique (run_id, node_id),
  unique (id, organization_id),
  check ((status in ('succeeded', 'failed', 'skipped', 'cancelled')) = (finished_at is not null)),
  check (finished_at is null or finished_at >= started_at),
  check (status <> 'failed' or error is not null)
);

create index workflow_run_steps_org_idx on public.workflow_run_steps (organization_id);
create index workflow_run_steps_task_idx on public.workflow_run_steps (task_id) where task_id is not null;

create trigger set_updated_at before update on public.workflow_run_steps
  for each row execute function private.set_updated_at();

alter table public.workflow_run_steps enable row level security;
revoke all on public.workflow_run_steps from anon, authenticated;
grant select on public.workflow_run_steps to authenticated;
create policy "workflow_run_steps: members read" on public.workflow_run_steps
  for select to authenticated using (organization_id in (select private.member_org_ids()));

-- A step's task changing state wakes its run.
create function private.wake_workflow_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.workflow_runs
  set advance_requested_at = now()
  where id = new.workflow_run_id and organization_id = new.organization_id
    and status in ('queued', 'running', 'waiting');
  return new;
end;
$$;

create trigger wake_workflow_run after update of status on public.tasks
  for each row
  when (new.workflow_run_id is not null and old.status is distinct from new.status
    and new.status in ('succeeded', 'failed', 'cancelled', 'skipped', 'waiting_approval', 'blocked', 'paused'))
  execute function private.wake_workflow_run();

-- ---------------------------------------------------------------------------
-- 4. Approval gates
-- ---------------------------------------------------------------------------

alter table public.approval_requests
  alter column tool_execution_id drop not null,
  add column kind text not null default 'tool_action' check (kind in ('tool_action', 'workflow_gate')),
  add constraint approval_requests_kind_shape check (
    (kind = 'tool_action') = (tool_execution_id is not null)
    and (kind <> 'workflow_gate' or (workflow_run_id is not null and workflow_version_id is not null))
  );

create unique index approval_requests_gate_task_idx on public.approval_requests (task_id) where kind = 'workflow_gate';

-- Replaces the governance version. A gate binds to its own displayed content:
-- the database sets its fingerprint to the SHA-256 of proposed_action, so
-- what the approver saw is exactly what was approved.
create or replace function private.guard_approval_request()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_execution public.tool_executions;
  v_task public.tasks;
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

  if new.organization_id <> old.organization_id
     or new.kind <> old.kind
     or new.tool_execution_id is distinct from old.tool_execution_id
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

-- Settles a gate's task after its request is decided (approved, rejected,
-- expired); the task changing state wakes the run.
create function private.settle_workflow_gate(p_request public.approval_requests)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_request.kind <> 'workflow_gate' then
    return;
  end if;
  if p_request.status = 'approved' then
    update public.tasks
    set status = 'succeeded', completed_at = now(),
        result = jsonb_build_object('decision', 'approved', 'note', p_request.decision_note)
    where id = p_request.task_id and organization_id = p_request.organization_id and status = 'waiting_approval';
  elsif p_request.status in ('rejected', 'expired') then
    update public.tasks
    set status = 'failed', completed_at = now(),
        result = jsonb_build_object('decision', p_request.status, 'note', p_request.decision_note),
        error = jsonb_build_object('code', 'approval_' || p_request.status, 'class', 'task',
          'message', case p_request.status when 'rejected' then 'The approval was rejected.' else 'The approval expired before anyone decided.' end)
    where id = p_request.task_id and organization_id = p_request.organization_id and status = 'waiting_approval';
  end if;
end;
$$;

-- Replaces the api_functions version: gates settle their step.
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

-- Replaces the task_runtime version: an expired gate fails its step (the run
-- follows the rejected path or ends as rejected).
create or replace function public.expire_overdue_approvals(p_limit integer default 100)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_request public.approval_requests%rowtype;
  v_count integer := 0;
begin
  if p_limit not between 1 and 1000 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  for v_request in
    select a.* from public.approval_requests as a
    where a.status = 'pending' and a.expires_at <= now()
    order by a.expires_at
    limit p_limit
    for update skip locked
  loop
    update public.approval_requests set status = 'expired', decided_at = now()
    where id = v_request.id returning * into v_request;
    if v_request.kind = 'workflow_gate' then
      perform private.settle_workflow_gate(v_request);
    else
      update public.tool_executions set status = 'cancelled'
      where id = v_request.tool_execution_id and status = 'awaiting_approval';
      update public.tasks set status = 'cancelled', completed_at = now()
      where id = v_request.task_id and employee_id is null and status = 'waiting_approval';
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Helpers
-- ---------------------------------------------------------------------------

-- Whether a given user (not necessarily the caller) holds at least a role.
create function private.user_has_min_role(p_organization_id uuid, p_user_id uuid, p_min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members as m
    where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active'
      and private.role_rank(m.role) >= private.role_rank(p_min_role)
  )
$$;

-- Checks a run's inputs against the inputs its version declares: no unknown
-- keys, required ones present, each of its type and size.
create function private.workflow_inputs_are_valid(p_declared jsonb, p_input jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_input) = 'object'
    and not exists (
      select 1 from jsonb_object_keys(p_input) as k
      where not exists (select 1 from jsonb_array_elements(p_declared) as d where d.value ->> 'key' = k)
    )
    and not exists (
      select 1 from jsonb_array_elements(p_declared) as d
      where ((d.value ->> 'required')::boolean and (not p_input ? (d.value ->> 'key')
               or jsonb_typeof(p_input -> (d.value ->> 'key')) = 'null'
               or p_input ->> (d.value ->> 'key') = ''))
         or (p_input ? (d.value ->> 'key') and jsonb_typeof(p_input -> (d.value ->> 'key')) <> 'null' and not case d.value ->> 'type'
               when 'number' then jsonb_typeof(p_input -> (d.value ->> 'key')) = 'number'
               when 'boolean' then jsonb_typeof(p_input -> (d.value ->> 'key')) = 'boolean'
               when 'email' then jsonb_typeof(p_input -> (d.value ->> 'key')) = 'string'
                 and char_length(p_input ->> (d.value ->> 'key')) <= 254
                 and (p_input ->> (d.value ->> 'key') = '' or p_input ->> (d.value ->> 'key') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
               when 'long_text' then jsonb_typeof(p_input -> (d.value ->> 'key')) = 'string' and char_length(p_input ->> (d.value ->> 'key')) <= 5000
               else jsonb_typeof(p_input -> (d.value ->> 'key')) = 'string' and char_length(p_input ->> (d.value ->> 'key')) <= 500
             end)
    )
$$;

-- Stops everything a finished or cancelled run still has going: steps not
-- finished are cancelled; tasks not started or waiting are cancelled with
-- their pending approvals and actions; a running employee task is asked to
-- stop at its next step. An action already executing can't be stopped.
create function private.stop_workflow_run_work(p_run_id uuid, p_organization_id uuid, p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
begin
  update public.workflow_run_steps
  set status = 'cancelled', finished_at = greatest(now(), started_at)
  where run_id = p_run_id and organization_id = p_organization_id and status in ('running', 'waiting');

  for v_task in
    select t.* from public.tasks as t
    where t.workflow_run_id = p_run_id and t.organization_id = p_organization_id
      and t.status in ('pending', 'queued', 'running', 'waiting_approval', 'blocked', 'paused')
    for update
  loop
    if v_task.status = 'running' and v_task.employee_id is not null then
      update public.tasks set cancel_requested_at = coalesce(cancel_requested_at, now()) where id = v_task.id;
      perform private.withdraw_task_actions(v_task.id, v_task.organization_id, p_user_id);
    else
      perform private.withdraw_task_actions(v_task.id, v_task.organization_id, p_user_id);
      update public.task_attempts set status = 'cancelled', finished_at = greatest(now(), started_at)
      where task_id = v_task.id and organization_id = v_task.organization_id and status = 'running';
      update public.tasks
      set status = 'cancelled', cancel_requested_at = coalesce(cancel_requested_at, now()), completed_at = now(),
          lease_expires_at = null, paused_at = null, paused_from = null, pause_requested_at = null
      where id = v_task.id;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Activating a version (service role, after the server validated it)
--
-- Errors: P0002 not found / the actor isn't an admin, 55000 archived,
-- 40001 the draft changed since it was validated, 22023 the typed name
-- doesn't match or invalid input. The version's graph is checked again by
-- workflow_versions' constraint.
-- ---------------------------------------------------------------------------

create function public.publish_workflow_version(
  p_workflow_id uuid,
  p_actor uuid,
  p_expected_lock_version integer,
  p_confirm_name text,
  p_graph jsonb,
  p_layout jsonb,
  p_report jsonb,
  p_schedule jsonb default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_workflow public.workflow_definitions%rowtype;
  v_version public.workflow_versions%rowtype;
  v_lock integer;
begin
  select * into v_workflow from public.workflow_definitions as w where w.id = p_workflow_id for update;
  if not found or p_actor is null or not private.user_has_min_role(v_workflow.organization_id, p_actor, 'admin') then
    raise exception 'workflow not found or role too low' using errcode = 'P0002';
  end if;
  if v_workflow.status = 'archived' then
    raise exception 'restore the workflow before activating it' using errcode = '55000';
  end if;
  if v_workflow.lock_version <> p_expected_lock_version then
    raise exception 'the draft changed after it was validated' using errcode = '40001';
  end if;
  if p_confirm_name is null or lower(btrim(p_confirm_name)) <> lower(btrim(v_workflow.name)) then
    raise exception 'type the workflow''s name to confirm' using errcode = '22023';
  end if;
  if p_schedule is not null and (p_schedule ->> 'cron' is null or p_schedule ->> 'timezone' is null
     or (p_schedule ->> 'next_run_at')::timestamptz <= now()) then
    raise exception 'invalid schedule' using errcode = '22023';
  end if;

  insert into public.workflow_versions (organization_id, workflow_id, version, graph_schema_version, graph, graph_sha256,
    layout, validation_report, source, generation_metadata, published_by)
  values (v_workflow.organization_id, v_workflow.id, 1, 2, p_graph, repeat('0', 64),
    coalesce(p_layout, '{}'::jsonb), coalesce(p_report, '{}'::jsonb),
    v_workflow.draft_source, v_workflow.draft_generation, p_actor)
  returning * into v_version;

  update public.workflow_definitions
  set current_version_id = v_version.id, status = 'active', activated_at = now(), activated_by = p_actor
  where id = v_workflow.id
  returning lock_version into v_lock;

  update public.workflow_triggers set enabled = false where workflow_id = v_workflow.id and enabled;
  if p_schedule is not null then
    insert into public.workflow_triggers (organization_id, workflow_id, workflow_version_id, trigger_type, cron_expression,
      timezone, next_run_at, created_by)
    values (v_workflow.organization_id, v_workflow.id, v_version.id, 'schedule', p_schedule ->> 'cron',
      p_schedule ->> 'timezone', (p_schedule ->> 'next_run_at')::timestamptz, p_actor);
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (v_workflow.organization_id, 'user', p_actor, 'workflow.activated', 'workflow_versions', v_version.id::text,
    jsonb_build_object('workflow_id', v_workflow.id, 'version', v_version.version, 'graph_sha256', v_version.graph_sha256,
      'scheduled', p_schedule is not null));
  return jsonb_build_object('version_id', v_version.id, 'version', v_version.version, 'lock_version', v_lock);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Workflow status (signed-in users)
--
-- pause (operators): no new runs start; running runs continue.
-- resume (admins): the current version is active again (schedules resume).
-- archive (admins): no new runs; history kept. restore (admins): back to
-- paused (or draft if it was never activated).
-- Errors: 42501 not signed in, P0002 not found / role too low, 55000 state.
-- ---------------------------------------------------------------------------

create function public.change_workflow_status(p_workflow_id uuid, p_action text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_workflow public.workflow_definitions%rowtype;
  v_status text;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_action not in ('pause', 'resume', 'archive', 'restore') then
    raise exception 'unknown action' using errcode = '22023';
  end if;
  select * into v_workflow from public.workflow_definitions as w where w.id = p_workflow_id for update;
  if not found or not private.has_min_role(v_workflow.organization_id, case when p_action = 'pause' then 'operator' else 'admin' end) then
    raise exception 'workflow not found or role too low' using errcode = 'P0002';
  end if;

  case p_action
    when 'pause' then
      if v_workflow.status <> 'active' then
        raise exception 'only an active workflow can be paused' using errcode = '55000';
      end if;
      v_status := 'paused';
      update public.workflow_triggers set enabled = false where workflow_id = v_workflow.id and enabled;
    when 'resume' then
      if v_workflow.status <> 'paused' or v_workflow.current_version_id is null then
        raise exception 'only a paused workflow with an activated version can be resumed' using errcode = '55000';
      end if;
      v_status := 'active';
      -- The server computes the next run time again (next_run_at null).
      update public.workflow_triggers set enabled = true, next_run_at = null
      where workflow_id = v_workflow.id and workflow_version_id = v_workflow.current_version_id;
    when 'archive' then
      if v_workflow.status = 'archived' then
        raise exception 'already archived' using errcode = '55000';
      end if;
      v_status := 'archived';
      update public.workflow_triggers set enabled = false where workflow_id = v_workflow.id and enabled;
    when 'restore' then
      if v_workflow.status <> 'archived' then
        raise exception 'only an archived workflow can be restored' using errcode = '55000';
      end if;
      v_status := case when v_workflow.current_version_id is null then 'draft' else 'paused' end;
  end case;

  update public.workflow_definitions set status = v_status where id = v_workflow.id;
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (v_workflow.organization_id, 'user', v_uid, 'workflow.' || p_action, 'workflow_definitions', v_workflow.id::text,
    jsonb_build_object('from', v_workflow.status, 'to', v_status));
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Starting and cancelling runs
--
-- start_workflow_run (operators): the workflow must be active; the run pins
-- its current version and is authorized by the admin who activated it.
-- Errors: 42501 not signed in, P0002 not found / role too low, 55000 not
-- active, 22023 invalid inputs or key, 23514 credential-shaped input.
-- ---------------------------------------------------------------------------

create function public.start_workflow_run(p_workflow_id uuid, p_input jsonb, p_idempotency_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_workflow public.workflow_definitions%rowtype;
  v_version public.workflow_versions%rowtype;
  v_key text;
  v_run_id uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_workflow from public.workflow_definitions as w where w.id = p_workflow_id;
  if not found or not private.has_min_role(v_workflow.organization_id, 'operator') then
    raise exception 'workflow not found or role too low' using errcode = 'P0002';
  end if;
  if v_workflow.status <> 'active' or v_workflow.current_version_id is null then
    raise exception 'only an active workflow can run' using errcode = '55000';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,100}$' then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  select * into v_version from public.workflow_versions as v where v.id = v_workflow.current_version_id;
  if v_version.graph_schema_version <> 2 then
    raise exception 'this version uses an old format; activate it again' using errcode = '55000';
  end if;
  if p_input is null or not private.workflow_inputs_are_valid(v_version.graph -> 'inputs', p_input) then
    raise exception 'the inputs don''t match what the workflow expects' using errcode = '22023';
  end if;
  if private.jsonb_contains_secret(p_input) then
    raise exception 'the inputs contain something that looks like a credential' using errcode = '23514';
  end if;

  v_key := 'manual:' || p_idempotency_key;
  insert into public.workflow_runs (organization_id, workflow_id, workflow_version_id, trigger_type, status, input,
    idempotency_key, created_by, authorized_by, advance_requested_at, deadline_at)
  values (v_workflow.organization_id, v_workflow.id, v_version.id, 'manual', 'queued', p_input, v_key, v_uid,
    v_version.published_by, now(),
    now() + make_interval(mins => coalesce((v_version.graph #>> '{settings,maxRunMinutes}')::integer, 1440)))
  on conflict (organization_id, idempotency_key) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    select r.id into v_run_id from public.workflow_runs as r
    where r.organization_id = v_workflow.organization_id and r.idempotency_key = v_key and r.workflow_id = v_workflow.id;
    if v_run_id is null then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return v_run_id;
  end if;

  insert into public.execution_events (organization_id, workflow_run_id, event_type, level, message, data)
  values (v_workflow.organization_id, v_run_id, 'run.queued', 'info', 'Run started by hand.',
    jsonb_build_object('workflow_version_id', v_version.id, 'version', v_version.version));
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (v_workflow.organization_id, 'user', v_uid, 'workflow_run.started', 'workflow_runs', v_run_id::text,
    jsonb_build_object('workflow_id', v_workflow.id, 'workflow_version_id', v_version.id));
  return v_run_id;
end;
$$;

-- Starts the run a schedule is due for (service role); moves the schedule on.
-- Returns null when the trigger isn't due, enabled, or its workflow active.
create function public.start_scheduled_workflow_run(p_trigger_id uuid, p_fire_at timestamptz, p_next_run_at timestamptz)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_trigger public.workflow_triggers%rowtype;
  v_workflow public.workflow_definitions%rowtype;
  v_version public.workflow_versions%rowtype;
  v_run_id uuid;
begin
  select * into v_trigger from public.workflow_triggers as t
  where t.id = p_trigger_id and t.trigger_type = 'schedule' and t.enabled for update skip locked;
  if not found or v_trigger.next_run_at is distinct from p_fire_at or p_fire_at > now() then
    return null;
  end if;
  if p_next_run_at is null or p_next_run_at <= p_fire_at then
    raise exception 'the next run must come after this one' using errcode = '22023';
  end if;
  update public.workflow_triggers set next_run_at = p_next_run_at, last_fired_at = now() where id = v_trigger.id;

  select * into v_workflow from public.workflow_definitions as w where w.id = v_trigger.workflow_id;
  if v_workflow.status <> 'active' or v_workflow.current_version_id is distinct from v_trigger.workflow_version_id then
    return null;
  end if;
  select * into v_version from public.workflow_versions as v where v.id = v_workflow.current_version_id;

  insert into public.workflow_runs (organization_id, workflow_id, workflow_version_id, trigger_id, trigger_type, status,
    input, idempotency_key, authorized_by, advance_requested_at, deadline_at)
  values (v_workflow.organization_id, v_workflow.id, v_version.id, v_trigger.id, 'schedule', 'queued', '{}'::jsonb,
    'schedule:' || v_trigger.id || ':' || extract(epoch from p_fire_at)::bigint, v_version.published_by, now(),
    now() + make_interval(mins => coalesce((v_version.graph #>> '{settings,maxRunMinutes}')::integer, 1440)))
  on conflict (organization_id, idempotency_key) do nothing
  returning id into v_run_id;
  if v_run_id is not null then
    insert into public.execution_events (organization_id, workflow_run_id, event_type, level, message, data)
    values (v_workflow.organization_id, v_run_id, 'run.queued', 'info', 'Run started by its schedule.',
      jsonb_build_object('workflow_version_id', v_version.id, 'version', v_version.version, 'scheduled_for', p_fire_at));
  end if;
  return v_run_id;
end;
$$;

-- cancel_workflow_run (operators): the run ends now; work not started is
-- withdrawn; a running employee step stops at its next step; an action
-- already executing finishes (the page says so).
create function public.cancel_workflow_run(p_run_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_run public.workflow_runs%rowtype;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_run from public.workflow_runs as r where r.id = p_run_id for update;
  if not found or not private.has_min_role(v_run.organization_id, 'operator') then
    raise exception 'run not found or role too low' using errcode = 'P0002';
  end if;
  if v_run.status not in ('queued', 'running', 'waiting') then
    raise exception 'this run has already finished' using errcode = '55000';
  end if;

  update public.workflow_runs
  set status = 'cancelled', cancel_requested_at = now(), finished_at = now(), started_at = coalesce(started_at, now()),
      lease_token = null, lease_expires_at = null, advance_requested_at = null, wake_at = null,
      summary = 'Cancelled.'
  where id = v_run.id;
  perform private.stop_workflow_run_work(v_run.id, v_run.organization_id, v_uid);

  insert into public.execution_events (organization_id, workflow_run_id, event_type, level, message)
  values (v_run.organization_id, v_run.id, 'run.cancelled', 'info', 'Run cancelled.');
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id)
  values (v_run.organization_id, 'user', v_uid, 'workflow_run.cancelled', 'workflow_runs', v_run.id::text);
  return 'cancelled';
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The orchestrator's lease (service role)
-- ---------------------------------------------------------------------------

-- Claims runs that need advancing: something changed, a step is due, the
-- deadline passed, or the previous orchestrator's lease expired.
create function public.claim_workflow_runs(p_limit integer default 5, p_lease_seconds integer default 120, p_run_id uuid default null)
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

-- Records what the orchestrator did, only while it still holds the lease:
-- steps (a finished step never changes again), events, the run's state, and
-- optionally its end (which stops any work left). Returns false when the
-- lease was lost; the caller then stops without writing anything else.
create function public.record_workflow_progress(
  p_run_id uuid,
  p_lease_token uuid,
  p_steps jsonb default '[]',
  p_events jsonb default '[]',
  p_status text default null,
  p_wake_at timestamptz default null,
  p_finish jsonb default null,
  p_release boolean default true,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_run public.workflow_runs%rowtype;
  v_final text;
begin
  select * into v_run from public.workflow_runs as r where r.id = p_run_id for update;
  if not found or v_run.lease_token is distinct from p_lease_token or v_run.status not in ('queued', 'running', 'waiting') then
    return false;
  end if;

  insert into public.workflow_run_steps as s (organization_id, run_id, node_id, node_type, label, status, branch, attempt,
    task_id, due_at, input, output, error, started_at, finished_at)
  select v_run.organization_id, v_run.id, x.node_id, x.node_type, x.label, x.status, x.branch, coalesce(x.attempt, 0),
    x.task_id, x.due_at, x.input, x.output, x.error, coalesce(x.started_at, now()),
    -- Times come from the database's clock, so a step never finishes before it started.
    case when x.status in ('succeeded', 'failed', 'skipped', 'cancelled') then greatest(now(), coalesce(x.started_at, now())) end
  from jsonb_to_recordset(coalesce(p_steps, '[]'::jsonb)) as x (node_id text, node_type text, label text, status text,
    branch text, attempt integer, task_id uuid, due_at timestamptz, input jsonb, output jsonb, error jsonb,
    started_at timestamptz, finished_at timestamptz)
  on conflict (run_id, node_id) do update
  set status = excluded.status, branch = excluded.branch, attempt = excluded.attempt, task_id = excluded.task_id,
      due_at = excluded.due_at, input = coalesce(excluded.input, s.input), output = excluded.output,
      error = excluded.error, finished_at = case when excluded.finished_at is null then null else greatest(excluded.finished_at, s.started_at) end
  where s.status not in ('succeeded', 'failed', 'skipped', 'cancelled');

  insert into public.execution_events (organization_id, workflow_run_id, task_id, event_type, level, message, data)
  select v_run.organization_id, v_run.id, x.task_id, x.event_type, coalesce(x.level, 'info'), x.message, coalesce(x.data, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb)) as x (event_type text, level text, message text, data jsonb, task_id uuid);

  if p_finish is not null then
    v_final := p_finish ->> 'status';
    if v_final not in ('succeeded', 'failed', 'rejected', 'timed_out') then
      raise exception 'invalid final status' using errcode = '22023';
    end if;
    update public.workflow_runs
    set status = v_final, finished_at = now(), lease_token = null, lease_expires_at = null,
        advance_requested_at = null, wake_at = null,
        error = case when v_final = 'succeeded' then null else coalesce(p_finish -> 'error', jsonb_build_object('code', v_final)) end,
        summary = left(p_finish ->> 'summary', 4000),
        output = p_finish -> 'output'
    where id = v_run.id;
    perform private.stop_workflow_run_work(v_run.id, v_run.organization_id, null);
    return true;
  end if;

  if p_status is not null and p_status not in ('running', 'waiting') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  update public.workflow_runs
  set status = coalesce(p_status, status),
      wake_at = case when p_release then p_wake_at else wake_at end,
      lease_token = case when p_release then null else lease_token end,
      lease_expires_at = case when p_release then null else now() + make_interval(secs => p_lease_seconds) end
  where id = v_run.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges
-- ---------------------------------------------------------------------------

revoke all on function
  private.user_has_min_role(uuid, uuid, text),
  private.workflow_inputs_are_valid(jsonb, jsonb),
  private.stop_workflow_run_work(uuid, uuid, uuid),
  private.settle_workflow_gate(public.approval_requests),
  private.wake_workflow_run(),
  public.publish_workflow_version(uuid, uuid, integer, text, jsonb, jsonb, jsonb, jsonb),
  public.change_workflow_status(uuid, text),
  public.start_workflow_run(uuid, jsonb, text),
  public.start_scheduled_workflow_run(uuid, timestamptz, timestamptz),
  public.cancel_workflow_run(uuid),
  public.claim_workflow_runs(integer, integer, uuid),
  public.record_workflow_progress(uuid, uuid, jsonb, jsonb, text, timestamptz, jsonb, boolean, integer)
from public, anon, authenticated;

grant execute on function
  public.change_workflow_status(uuid, text),
  public.start_workflow_run(uuid, jsonb, text),
  public.cancel_workflow_run(uuid)
to authenticated;

grant execute on function
  public.publish_workflow_version(uuid, uuid, integer, text, jsonb, jsonb, jsonb, jsonb),
  public.start_scheduled_workflow_run(uuid, timestamptz, timestamptz),
  public.claim_workflow_runs(integer, integer, uuid),
  public.record_workflow_progress(uuid, uuid, jsonb, jsonb, text, timestamptz, jsonb, boolean, integer),
  private.user_has_min_role(uuid, uuid, text),
  private.workflow_inputs_are_valid(jsonb, jsonb),
  private.stop_workflow_run_work(uuid, uuid, uuid),
  private.settle_workflow_gate(public.approval_requests)
to service_role;

comment on table public.workflow_run_steps is
  'One row per workflow step a run reached (or skipped). Written only by the orchestrator under its lease (record_workflow_progress); a finished step never changes.';
comment on column public.workflow_runs.authorized_by is
  'The admin who activated the pinned version. Runs act on their authority and stop if they are no longer an admin.';
comment on column public.approval_requests.kind is
  'tool_action: bound to one tool execution''s exact input. workflow_gate: an approval step of a workflow run, bound to the SHA-256 of proposed_action (set by the database).';

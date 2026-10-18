-- Execution: workflow runs, tasks and their dependencies, attempts, tool
-- executions, and the execution event stream.
--
-- Execution state is written by trusted server code (workers, the tool
-- executor) through the service role; clients only read it. Every unit of
-- work carries an idempotency key unique within its organization so retries
-- of the same step never create duplicates.

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workflow_id uuid not null,
  workflow_version_id uuid not null,
  trigger_id uuid,
  trigger_type text not null check (trigger_type in ('manual', 'schedule', 'integration_event', 'webhook')),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'rejected', 'timed_out'
  )),
  input jsonb not null default '{}'::jsonb
    check (jsonb_typeof(input) = 'object' and not private.jsonb_contains_secret(input)),
  -- Pointer to stored results (e.g. a storage path); large outputs are not inlined.
  output_ref text check (char_length(output_ref) <= 1024),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  engine_run_id text check (char_length(engine_run_id) <= 200),
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  cancel_requested_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workflow_id, organization_id)
    references public.workflow_definitions (id, organization_id) on delete cascade,
  foreign key (workflow_version_id, workflow_id)
    references public.workflow_versions (id, workflow_id),
  foreign key (trigger_id, organization_id)
    references public.workflow_triggers (id, organization_id) on delete set null (trigger_id),
  unique (organization_id, idempotency_key),
  unique (id, organization_id),
  check (finished_at is null or started_at is null or finished_at >= started_at),
  check ((status in ('succeeded', 'failed', 'cancelled', 'rejected', 'timed_out')) = (finished_at is not null)),
  check (status <> 'failed' or error is not null)
);

create index workflow_runs_org_status_idx on public.workflow_runs (organization_id, status, queued_at desc);
create index workflow_runs_workflow_idx on public.workflow_runs (workflow_id, queued_at desc);
create index workflow_runs_version_idx on public.workflow_runs (workflow_version_id);
create index workflow_runs_trigger_idx on public.workflow_runs (trigger_id) where trigger_id is not null;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_run_id uuid,
  -- The workflow graph node this task executes.
  node_id text check (node_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  employee_id uuid,
  -- Employee configuration version pinned when the task started.
  employee_version_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 500),
  instructions text check (char_length(instructions) <= 50000),
  input jsonb not null default '{}'::jsonb
    check (jsonb_typeof(input) = 'object' and not private.jsonb_contains_secret(input)),
  source text not null check (source in ('workflow', 'chat', 'manual', 'api', 'schedule')),
  status text not null default 'pending' check (status in (
    'pending', 'queued', 'running', 'waiting_approval', 'blocked',
    'succeeded', 'failed', 'cancelled', 'skipped'
  )),
  priority smallint not null default 0 check (priority between -100 and 100),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 20),
  attempt_count smallint not null default 0,
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and not private.jsonb_contains_secret(result))),
  result_ref text check (char_length(result_ref) <= 1024),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workflow_run_id, organization_id)
    references public.workflow_runs (id, organization_id) on delete cascade,
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete set null (employee_id),
  foreign key (employee_version_id, employee_id)
    references public.employee_versions (id, employee_id) on delete set null (employee_version_id),
  unique (organization_id, idempotency_key),
  unique (id, organization_id),
  check (attempt_count between 0 and max_attempts),
  check ((workflow_run_id is null) = (node_id is null)),
  check ((source = 'workflow') = (workflow_run_id is not null)),
  check (completed_at is null or started_at is null or completed_at >= started_at),
  check ((status in ('succeeded', 'failed', 'cancelled', 'skipped')) = (completed_at is not null)),
  check (status <> 'failed' or error is not null)
);

create index tasks_org_status_idx on public.tasks (organization_id, status, created_at desc);
create index tasks_run_idx on public.tasks (workflow_run_id) where workflow_run_id is not null;
create index tasks_employee_idx on public.tasks (employee_id, status) where employee_id is not null;
create index tasks_due_idx on public.tasks (scheduled_at) where status in ('pending', 'queued');

create table public.task_dependencies (
  organization_id uuid not null,
  task_id uuid not null,
  depends_on_task_id uuid not null,
  dependency_type text not null default 'finish_to_start' check (dependency_type in ('finish_to_start')),
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete cascade,
  foreign key (depends_on_task_id, organization_id) references public.tasks (id, organization_id) on delete cascade,
  check (task_id <> depends_on_task_id)
);

create index task_dependencies_depends_on_idx on public.task_dependencies (depends_on_task_id);
create index task_dependencies_org_idx on public.task_dependencies (organization_id);

create table public.task_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  attempt_number smallint not null check (attempt_number >= 1),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  engine_attempt_id text check (char_length(engine_attempt_id) <= 200),
  model_input_tokens bigint not null default 0 check (model_input_tokens >= 0),
  model_output_tokens bigint not null default 0 check (model_output_tokens >= 0),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete cascade,
  unique (task_id, attempt_number),
  unique (id, task_id),
  check (finished_at is null or finished_at >= started_at),
  check ((status = 'running') = (finished_at is null)),
  check (status <> 'failed' or error is not null)
);

create index task_attempts_org_idx on public.task_attempts (organization_id);

create table public.tool_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  task_attempt_id uuid,
  employee_id uuid,
  integration_id uuid,
  tool_key text not null check (tool_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  risk_level text not null check (risk_level in ('read', 'write_internal', 'write_external', 'sensitive')),
  -- Redacted copy of the validated input, and the fingerprint of the exact
  -- (unredacted) input. Approvals bind to the fingerprint.
  input_redacted jsonb not null default '{}'::jsonb
    check (jsonb_typeof(input_redacted) = 'object' and not private.jsonb_contains_secret(input_redacted)),
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_redacted jsonb
    check (output_redacted is null or not private.jsonb_contains_secret(output_redacted)),
  output_ref text check (char_length(output_ref) <= 1024),
  status text not null default 'proposed' check (status in (
    'proposed', 'awaiting_approval', 'approved', 'rejected', 'executing',
    'succeeded', 'failed', 'skipped', 'cancelled'
  )),
  policy_decision text not null check (policy_decision in ('allow', 'require_approval', 'deny')),
  policy_reason text check (char_length(policy_reason) <= 1000),
  policy_id uuid,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete cascade,
  foreign key (task_attempt_id, task_id)
    references public.task_attempts (id, task_id) on delete set null (task_attempt_id),
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete set null (employee_id),
  foreign key (integration_id, organization_id)
    references public.integrations (id, organization_id) on delete set null (integration_id),
  unique (organization_id, idempotency_key),
  unique (id, organization_id),
  -- Denied calls are recorded but never run; allowed calls never wait for approval.
  check (policy_decision <> 'deny' or status = 'skipped'),
  check (policy_decision <> 'allow' or status not in ('awaiting_approval', 'approved', 'rejected')),
  check (finished_at is null or started_at is null or finished_at >= started_at),
  check (status <> 'failed' or error is not null)
);

create index tool_executions_org_created_idx on public.tool_executions (organization_id, created_at desc);
create index tool_executions_task_idx on public.tool_executions (task_id);
create index tool_executions_pending_idx on public.tool_executions (organization_id, status)
  where status in ('proposed', 'awaiting_approval', 'approved', 'executing');
create index tool_executions_employee_idx on public.tool_executions (employee_id) where employee_id is not null;
create index tool_executions_integration_idx on public.tool_executions (integration_id) where integration_id is not null;

create table public.execution_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_run_id uuid,
  task_id uuid,
  tool_execution_id uuid,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_.]{1,63}$'),
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  message text check (char_length(message) <= 2000 and not private.text_contains_secret(message)),
  data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(data) = 'object' and not private.jsonb_contains_secret(data)),
  created_at timestamptz not null default now(),
  foreign key (workflow_run_id, organization_id)
    references public.workflow_runs (id, organization_id) on delete cascade,
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete cascade,
  foreign key (tool_execution_id, organization_id)
    references public.tool_executions (id, organization_id) on delete cascade,
  check (num_nonnulls(workflow_run_id, task_id, tool_execution_id) >= 1)
);

create index execution_events_org_created_idx on public.execution_events (organization_id, created_at desc);
create index execution_events_run_idx on public.execution_events (workflow_run_id, id) where workflow_run_id is not null;
create index execution_events_task_idx on public.execution_events (task_id, id) where task_id is not null;
create index execution_events_tool_idx on public.execution_events (tool_execution_id, id) where tool_execution_id is not null;

create trigger set_updated_at before update on public.workflow_runs
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.tool_executions
  for each row execute function private.set_updated_at();
create trigger prevent_update before update on public.execution_events
  for each row execute function private.prevent_update();

-- ---------------------------------------------------------------------------
-- Integrity rules
-- ---------------------------------------------------------------------------

-- Dependencies must stay within one workflow run (or both be standalone) and
-- must not form a cycle.
create function private.check_task_dependency()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cycle boolean;
begin
  if (select t.workflow_run_id from public.tasks as t where t.id = new.task_id)
     is distinct from (select t.workflow_run_id from public.tasks as t where t.id = new.depends_on_task_id) then
    raise exception 'dependent tasks must belong to the same workflow run' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('task_dependencies:' || new.organization_id::text, 0));

  with recursive upstream (id) as (
    select d.depends_on_task_id from public.task_dependencies as d where d.task_id = new.depends_on_task_id
    union
    select d.depends_on_task_id from public.task_dependencies as d join upstream as u on d.task_id = u.id
  )
  select exists (select 1 from upstream where id = new.task_id) into v_cycle;

  if v_cycle then
    raise exception 'task dependency would create a cycle' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger check_task_dependency before insert on public.task_dependencies
  for each row execute function private.check_task_dependency();

-- The proposed action is fixed once recorded; only its lifecycle may change.
-- (employee_id / integration_id may still be cleared by ON DELETE SET NULL.)
create function private.guard_tool_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.input_sha256 <> old.input_sha256
     or new.input_redacted <> old.input_redacted
     or new.tool_key <> old.tool_key
     or new.risk_level <> old.risk_level
     or new.policy_decision <> old.policy_decision
     or new.idempotency_key <> old.idempotency_key
     or new.task_id <> old.task_id
     or (new.integration_id is distinct from old.integration_id and new.integration_id is not null)
     or (new.employee_id is distinct from old.employee_id and new.employee_id is not null) then
    raise exception 'a tool execution''s proposed action cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guard_tool_execution before update on public.tool_executions
  for each row execute function private.guard_tool_execution();

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges: members read; server writes.
-- ---------------------------------------------------------------------------

alter table public.workflow_runs enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.task_attempts enable row level security;
alter table public.tool_executions enable row level security;
alter table public.execution_events enable row level security;

revoke all on public.workflow_runs, public.tasks, public.task_dependencies, public.task_attempts,
  public.tool_executions, public.execution_events
from anon, authenticated;

grant select on public.workflow_runs, public.tasks, public.task_dependencies, public.task_attempts,
  public.tool_executions, public.execution_events
to authenticated;

create policy "workflow_runs: members read" on public.workflow_runs
  for select to authenticated using (organization_id in (select private.member_org_ids()));
create policy "tasks: members read" on public.tasks
  for select to authenticated using (organization_id in (select private.member_org_ids()));
create policy "task_dependencies: members read" on public.task_dependencies
  for select to authenticated using (organization_id in (select private.member_org_ids()));
create policy "task_attempts: members read" on public.task_attempts
  for select to authenticated using (organization_id in (select private.member_org_ids()));
create policy "tool_executions: members read" on public.tool_executions
  for select to authenticated using (organization_id in (select private.member_org_ids()));
create policy "execution_events: members read" on public.execution_events
  for select to authenticated using (organization_id in (select private.member_org_ids()));

-- Task runtime: giving active AI employees bounded tasks.
--
-- The concepts stay separate tables:
--   employee  ai_employees + employee_versions (who does the work, how)
--   skill     skills + employee_skills (what it is known for)
--   tool      the tool catalog + employee_tool_permissions + integration_actions
--   task      tasks (one unit of work; an employee task pins a version)
--   workflow / workflow run   workflow_definitions, workflow_versions, workflow_runs
--   attempt   task_attempts (one try at a task; a retry is a new attempt)
--   approval  approval_requests (bound to one tool execution's exact payload)
--   evidence  task_evidence (what a task observed: passages, tool results)
--
-- Employee tasks are a queue in Postgres. A worker claims a task with a lease
-- (claim_employee_tasks), runs the shared employee runtime, and saves a
-- checkpoint (the model conversation and counters) after every step, so a
-- task that waits for an approval or a requester's reply, or whose server
-- stopped, continues from its last checkpoint instead of starting again.
-- An attempt stays "running" while its task waits; only failures start a new
-- attempt, so waiting never uses up retries.
--
-- Everything here is written by trusted server code (service role) or by the
-- security-definer functions below; clients read.

-- ---------------------------------------------------------------------------
-- 1. Tasks: worker lease and cancellation
-- ---------------------------------------------------------------------------

alter table public.tasks
  add column lease_expires_at timestamptz,
  add column cancel_requested_at timestamptz,
  -- Employee tasks (run by the task runtime) hold a lease exactly while running.
  -- Tasks the integration executor creates for a person's action have no employee.
  add constraint tasks_employee_lease_while_running
    check (employee_id is null or ((status = 'running') = (lease_expires_at is not null))),
  add constraint tasks_instructions_have_no_secret
    check (not private.text_contains_secret(instructions)),
  add constraint tasks_title_has_no_secret
    check (not private.text_contains_secret(title));

create index tasks_claimable_idx on public.tasks (status, scheduled_at, lease_expires_at)
  where employee_id is not null and status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- 2. Attempts: usage, counters and the checkpoint
-- ---------------------------------------------------------------------------

alter table public.task_attempts
  add column model text check (char_length(model) <= 100),
  add column cost_micros bigint not null default 0 check (cost_micros >= 0),
  add column turn_count integer not null default 0 check (turn_count >= 0),
  add column tool_call_count integer not null default 0 check (tool_call_count >= 0),
  -- Time spent running (not waiting), in milliseconds.
  add column active_ms bigint not null default 0 check (active_ms >= 0),
  -- The conversation and counters to continue from. Server only (see grants).
  add column checkpoint jsonb
    check (checkpoint is null or (jsonb_typeof(checkpoint) = 'object'
      and not private.jsonb_contains_secret(checkpoint)
      and octet_length(checkpoint::text) <= 2000000)),
  add column checkpoint_at timestamptz;

create index task_attempts_task_running_idx on public.task_attempts (task_id) where status = 'running';

-- ---------------------------------------------------------------------------
-- 3. Evidence: what a task observed
--
-- Knowledge passages it retrieved and integration results it received, with
-- the excerpt it saw. Evidence is untrusted data kept for review and for
-- verifying results; it never grants anything. Rows are immutable.
-- Knowledge chunks are referenced by id only (no foreign key): reprocessing a
-- document replaces its chunks, and the excerpt is kept here.
-- ---------------------------------------------------------------------------

create table public.task_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  task_attempt_id uuid,
  kind text not null check (kind in ('knowledge_passage', 'tool_result')),
  tool_key text check (tool_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  tool_execution_id uuid,
  knowledge_source_id uuid,
  knowledge_chunk_id uuid,
  -- Citation label (S1…) or the tool call's receipt.
  label text check (char_length(label) <= 64),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  excerpt text check (char_length(excerpt) <= 4000 and not private.text_contains_secret(excerpt)),
  data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(data) = 'object' and not private.jsonb_contains_secret(data)),
  suspected_instructions boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete cascade,
  foreign key (task_attempt_id, task_id)
    references public.task_attempts (id, task_id) on delete set null (task_attempt_id),
  foreign key (tool_execution_id, organization_id)
    references public.tool_executions (id, organization_id) on delete set null (tool_execution_id),
  foreign key (knowledge_source_id, organization_id)
    references public.knowledge_sources (id, organization_id) on delete set null (knowledge_source_id),
  check (kind <> 'tool_result' or tool_key is not null)
);

create index task_evidence_task_idx on public.task_evidence (task_id, created_at);
create index task_evidence_org_idx on public.task_evidence (organization_id);
create index task_evidence_attempt_idx on public.task_evidence (task_attempt_id) where task_attempt_id is not null;
create index task_evidence_execution_idx on public.task_evidence (tool_execution_id) where tool_execution_id is not null;
create index task_evidence_source_idx on public.task_evidence (knowledge_source_id) where knowledge_source_id is not null;

create trigger prevent_update before update on public.task_evidence
  for each row execute function private.prevent_update();

-- ---------------------------------------------------------------------------
-- 4. Assigning a task
--
-- An operator assigns a bounded task to an active employee. The task pins the
-- employee's active version and is queued for the runtime. Repeating the same
-- idempotency key returns the first task instead of creating another.
-- Errors: 42501 not signed in, P0002 not found / role too low, 55000 the
-- employee isn't active, 22023 invalid title or instructions, 23514
-- credential-shaped text.
-- ---------------------------------------------------------------------------

create function public.assign_employee_task(
  p_employee_id uuid,
  p_title text,
  p_instructions text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_employee public.ai_employees%rowtype;
  v_key text;
  v_task_id uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_employee from public.ai_employees as e where e.id = p_employee_id;
  if not found or not private.has_min_role(v_employee.organization_id, 'operator') then
    raise exception 'employee not found or role too low' using errcode = 'P0002';
  end if;
  if v_employee.status <> 'active' or v_employee.active_version_id is null then
    raise exception 'only an active employee can be given tasks' using errcode = '55000';
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 200 then
    raise exception 'the task needs a title of up to 200 characters' using errcode = '22023';
  end if;
  if p_instructions is not null and char_length(p_instructions) > 20000 then
    raise exception 'the instructions are too long' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,100}$' then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if private.text_contains_secret(p_title) or private.text_contains_secret(p_instructions) then
    raise exception 'the task contains something that looks like a credential' using errcode = '23514';
  end if;

  v_key := 'employee-task:' || p_idempotency_key;
  insert into public.tasks (
    organization_id, employee_id, employee_version_id, title, instructions, source, status,
    idempotency_key, max_attempts, created_by
  )
  values (
    v_employee.organization_id, v_employee.id, v_employee.active_version_id, btrim(p_title),
    nullif(btrim(coalesce(p_instructions, '')), ''), 'manual', 'queued', v_key, 3, v_uid
  )
  on conflict (organization_id, idempotency_key) do nothing
  returning id into v_task_id;

  if v_task_id is null then
    select t.id into v_task_id from public.tasks as t
    where t.organization_id = v_employee.organization_id and t.idempotency_key = v_key
      and t.employee_id = v_employee.id;
    if v_task_id is null then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return v_task_id;
  end if;

  insert into public.execution_events (organization_id, task_id, event_type, level, message, data)
  values (v_employee.organization_id, v_task_id, 'task.queued', 'info', 'Task assigned and queued.',
    jsonb_build_object('employee_id', v_employee.id, 'employee_version_id', v_employee.active_version_id));
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (v_employee.organization_id, 'user', v_uid, 'task.assigned', 'tasks', v_task_id::text,
    jsonb_build_object('employee_id', v_employee.id, 'employee_version_id', v_employee.active_version_id));
  return v_task_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Claiming tasks (service role)
--
-- Claims queued employee tasks that are due, and running tasks whose lease
-- expired (their server stopped). A lost attempt ends as "timed_out" and a new
-- attempt continues from the last checkpoint, until max_attempts is used up.
-- A task resumed after an approval or a reply keeps its running attempt.
-- A task whose cancellation was requested is cancelled instead of claimed.
-- ---------------------------------------------------------------------------

create function public.claim_employee_tasks(p_limit integer default 5, p_lease_seconds integer default 120)
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
      and ((t.status = 'queued' and (t.scheduled_at is null or t.scheduled_at <= now()))
        or (t.status = 'running' and t.lease_expires_at < now()))
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
      update public.task_attempts set status = 'cancelled', finished_at = now()
      where task_attempts.task_id = v_task.id and status = 'running';
      update public.tasks set status = 'cancelled', lease_expires_at = null, completed_at = now()
      where id = v_task.id;
      insert into public.execution_events (organization_id, task_id, event_type, level, message)
      values (v_task.organization_id, v_task.id, 'task.cancelled', 'info', 'Task cancelled.');
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

-- ---------------------------------------------------------------------------
-- 6. Resuming after an approval decision
--
-- When the last pending tool execution of a waiting employee task finishes
-- (run, failed, rejected, cancelled or expired), the task goes back to the
-- queue to continue from its checkpoint.
-- ---------------------------------------------------------------------------

create function private.requeue_task_after_tool_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.employee_id is not null
     and new.status is distinct from old.status
     and new.status in ('succeeded', 'failed', 'rejected', 'cancelled', 'skipped')
     and not exists (
       select 1 from public.tool_executions as e
       where e.task_id = new.task_id and e.id <> new.id
         and e.status in ('proposed', 'awaiting_approval', 'approved', 'executing')
     ) then
    update public.tasks set status = 'queued'
    where id = new.task_id and organization_id = new.organization_id
      and status = 'waiting_approval' and employee_id is not null;
  end if;
  return new;
end;
$$;

create trigger requeue_task_after_tool_execution after update of status on public.tool_executions
  for each row execute function private.requeue_task_after_tool_execution();

-- ---------------------------------------------------------------------------
-- 7. Cancelling and replying (operators)
--
-- cancel_employee_task: a task not yet running is cancelled now (with its
-- pending approvals); a running task is cancelled at its next step.
-- reply_to_employee_task: answers an employee that escalated (task
-- "blocked"); the task continues with the reply.
-- Errors: 42501 not signed in, P0002 not found / role too low, 55000 state
-- doesn't allow it, 22023 invalid reply, 23514 credential-shaped reply.
-- ---------------------------------------------------------------------------

create function public.cancel_employee_task(p_task_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_task public.tasks%rowtype;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_task from public.tasks as t where t.id = p_task_id for update;
  if not found or v_task.employee_id is null or not private.has_min_role(v_task.organization_id, 'operator') then
    raise exception 'task not found or role too low' using errcode = 'P0002';
  end if;

  if v_task.status = 'running' then
    update public.tasks set cancel_requested_at = coalesce(cancel_requested_at, now()) where id = v_task.id;
    insert into public.execution_events (organization_id, task_id, event_type, level, message)
    values (v_task.organization_id, v_task.id, 'task.cancel_requested', 'info', 'Cancellation requested; the task stops at its next step.');
    return 'cancel_requested';
  end if;
  if v_task.status not in ('pending', 'queued', 'waiting_approval', 'blocked') then
    raise exception 'this task has already finished' using errcode = '55000';
  end if;

  update public.tasks
  set status = 'cancelled', cancel_requested_at = coalesce(cancel_requested_at, now()), completed_at = now()
  where id = v_task.id;
  update public.task_attempts set status = 'cancelled', finished_at = greatest(now(), started_at)
  where task_attempts.task_id = v_task.id and status = 'running';
  update public.approval_requests set status = 'cancelled', decided_at = now(), decided_by = v_uid
  where approval_requests.task_id = v_task.id and status = 'pending';
  update public.tool_executions set status = 'cancelled'
  where tool_executions.task_id = v_task.id and status in ('proposed', 'awaiting_approval', 'approved');

  insert into public.execution_events (organization_id, task_id, event_type, level, message)
  values (v_task.organization_id, v_task.id, 'task.cancelled', 'info', 'Task cancelled.');
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id)
  values (v_task.organization_id, 'user', v_uid, 'task.cancelled', 'tasks', v_task.id::text);
  return 'cancelled';
end;
$$;

create function public.reply_to_employee_task(p_task_id uuid, p_message text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_attempt_id uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_task from public.tasks as t where t.id = p_task_id for update;
  if not found or v_task.employee_id is null or not private.has_min_role(v_task.organization_id, 'operator') then
    raise exception 'task not found or role too low' using errcode = 'P0002';
  end if;
  if v_task.status <> 'blocked' then
    raise exception 'only a task waiting for a reply can be answered' using errcode = '55000';
  end if;
  if p_message is null or char_length(btrim(p_message)) not between 1 and 4000 then
    raise exception 'write a reply of up to 4000 characters' using errcode = '22023';
  end if;
  if private.text_contains_secret(p_message) then
    raise exception 'the reply contains something that looks like a credential' using errcode = '23514';
  end if;

  select a.id into v_attempt_id from public.task_attempts as a
  where a.task_id = v_task.id and a.status = 'running' and a.checkpoint is not null
  order by a.attempt_number desc limit 1;
  if v_attempt_id is null then
    raise exception 'this task has nothing to continue from' using errcode = '55000';
  end if;

  update public.task_attempts
  set checkpoint = jsonb_set(checkpoint, '{requesterReply}', jsonb_build_object('text', btrim(p_message), 'by', v_uid, 'at', now()))
  where id = v_attempt_id;
  update public.tasks set status = 'queued' where id = v_task.id;

  insert into public.execution_events (organization_id, task_id, event_type, level, message)
  values (v_task.organization_id, v_task.id, 'task.replied', 'info', 'The requester replied; the task continues.');
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id)
  values (v_task.organization_id, 'user', v_uid, 'task.replied', 'tasks', v_task.id::text);
  return 'queued';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Expiring approvals (service role)
--
-- decide_approval expires a request only when someone opens it; this expires
-- every overdue request, cancels its tool execution (which re-queues a waiting
-- employee task, see 6) and closes a person's waiting action task.
-- ---------------------------------------------------------------------------

create function public.expire_overdue_approvals(p_limit integer default 100)
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
    update public.approval_requests set status = 'expired', decided_at = now() where id = v_request.id;
    update public.tool_executions set status = 'cancelled'
    where id = v_request.tool_execution_id and status = 'awaiting_approval';
    update public.tasks set status = 'cancelled', completed_at = now()
    where id = v_request.task_id and employee_id is null and status = 'waiting_approval';
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Privileges and Row Level Security
-- ---------------------------------------------------------------------------

alter table public.task_evidence enable row level security;
revoke all on public.task_evidence from anon, authenticated;
grant select on public.task_evidence to authenticated;
create policy "task_evidence: members read" on public.task_evidence
  for select to authenticated using (organization_id in (select private.member_org_ids()));

-- Members keep reading attempts, except the checkpoint (the raw model
-- conversation, which the task's events and evidence summarize).
revoke select on public.task_attempts from authenticated;
grant select (
  id, organization_id, task_id, attempt_number, status, engine_attempt_id, model_input_tokens,
  model_output_tokens, error, started_at, finished_at, created_at, model, cost_micros, turn_count,
  tool_call_count, active_ms, checkpoint_at
) on public.task_attempts to authenticated;

revoke all on function
  public.assign_employee_task(uuid, text, text, text),
  public.cancel_employee_task(uuid),
  public.reply_to_employee_task(uuid, text),
  public.claim_employee_tasks(integer, integer),
  public.expire_overdue_approvals(integer)
from public, anon, authenticated;

grant execute on function
  public.assign_employee_task(uuid, text, text, text),
  public.cancel_employee_task(uuid),
  public.reply_to_employee_task(uuid, text)
to authenticated;

grant execute on function
  public.claim_employee_tasks(integer, integer),
  public.expire_overdue_approvals(integer)
to service_role;

comment on table public.task_evidence is
  'What an employee task observed (knowledge passages, integration results). Untrusted data; server writes, members read.';
comment on column public.task_attempts.checkpoint is
  'Model conversation and counters a task continues from. Server only.';

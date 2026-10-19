-- Durable execution: the rest of a task's life cycle.
--
-- Builds on task_runtime (queue, leases, attempts, checkpoints):
--   * a "paused" state, with pause/resume by operators and by the runtime
--     when an employee is paused
--   * deadlines: a task that hasn't finished by its deadline fails as
--     timed out, wherever it is waiting
--   * dependencies: a task can wait for other tasks; it is queued when they
--     all succeed and skipped when one of them doesn't
--   * priority and reassignment before work starts
--   * manual retry of a failed task, continuing from its last checkpoint with
--     a fresh set of run limits
--   * cancellation that withdraws pending approvals at once, even while the
--     employee is mid-step
--   * claiming one specific task, so the execution engine can run each task
--     as its own job
--
-- The execution engine (Trigger.dev, ADR-026) only executes; every state
-- change lands here, through these functions or the runner (service role).

-- ---------------------------------------------------------------------------
-- 1. Tasks: paused state, deadline
-- ---------------------------------------------------------------------------

alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks
  add constraint tasks_status_check check (status in (
    'pending', 'queued', 'running', 'waiting_approval', 'blocked', 'paused',
    'succeeded', 'failed', 'cancelled', 'skipped'
  )),
  add column deadline_at timestamptz,
  add column pause_requested_at timestamptz,
  add column paused_at timestamptz,
  -- Where a paused task returns to when it is resumed.
  add column paused_from text check (paused_from in ('pending', 'queued', 'waiting_approval', 'blocked')),
  add constraint tasks_paused_state check (
    (status = 'paused') = (paused_at is not null) and (status = 'paused') = (paused_from is not null)
  ),
  add constraint tasks_deadline_after_creation check (deadline_at is null or deadline_at > created_at);

create index tasks_deadline_idx on public.tasks (deadline_at)
  where employee_id is not null and status in ('pending', 'queued', 'waiting_approval', 'blocked', 'paused');
-- Task Center filters by failure class.
create index tasks_org_failure_class_idx on public.tasks (organization_id, (error ->> 'class'))
  where error is not null;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- Withdraws a task's pending approvals and the actions waiting on them. An
-- action already executing can't be stopped; one that already ran stays done.
create function private.withdraw_task_actions(p_task_id uuid, p_organization_id uuid, p_user_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.approval_requests
  set status = 'cancelled', decided_at = now(), decided_by = p_user_id
  where task_id = p_task_id and organization_id = p_organization_id and status = 'pending';
  update public.tool_executions
  set status = 'cancelled'
  where task_id = p_task_id and organization_id = p_organization_id
    and status in ('proposed', 'awaiting_approval', 'approved');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Ends a task that passed its deadline (any state but running with a live
-- lease, which the runner stops itself).
create function private.time_out_task(p_task public.tasks)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.task_attempts
  set status = 'timed_out', finished_at = greatest(now(), started_at),
      error = jsonb_build_object('code', 'deadline_passed', 'class', 'limit',
        'message', 'The task passed its deadline.')
  where task_id = p_task.id and organization_id = p_task.organization_id and status = 'running';
  perform private.withdraw_task_actions(p_task.id, p_task.organization_id, null);
  update public.tasks
  set status = 'failed', lease_expires_at = null, completed_at = now(),
      paused_at = null, paused_from = null, pause_requested_at = null,
      error = jsonb_build_object('code', 'deadline_passed', 'class', 'limit',
        'message', 'The task didn''t finish before its deadline.')
  where id = p_task.id and organization_id = p_task.organization_id;
  insert into public.execution_events (organization_id, task_id, event_type, level, message)
  values (p_task.organization_id, p_task.id, 'task.timed_out', 'error', 'The task didn''t finish before its deadline.');
end;
$$;

create function private.task_dependencies_met(p_task_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (
    select 1 from public.task_dependencies as d
    join public.tasks as u on u.id = d.depends_on_task_id and u.organization_id = d.organization_id
    where d.task_id = p_task_id and u.status <> 'succeeded'
  )
$$;

-- ---------------------------------------------------------------------------
-- 3. Dependencies: release or skip dependents when a task finishes
-- ---------------------------------------------------------------------------

create function private.settle_dependent_tasks()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'succeeded' then
    with released as (
      update public.tasks as t
      set status = 'queued'
      where t.organization_id = new.organization_id and t.status = 'pending'
        and t.id in (select d.task_id from public.task_dependencies as d where d.depends_on_task_id = new.id)
        and private.task_dependencies_met(t.id)
      returning t.id, t.organization_id
    )
    insert into public.execution_events (organization_id, task_id, event_type, level, message)
    select r.organization_id, r.id, 'task.dependencies_met', 'info', 'Every task it depends on succeeded; queued.'
    from released as r;

    update public.tasks as t
    set paused_from = 'queued'
    where t.organization_id = new.organization_id and t.status = 'paused' and t.paused_from = 'pending'
      and t.id in (select d.task_id from public.task_dependencies as d where d.depends_on_task_id = new.id)
      and private.task_dependencies_met(t.id);
  else
    -- Skipping a dependent fires this trigger again for its own dependents.
    with skipped as (
      update public.tasks as t
      set status = 'skipped', completed_at = now(), paused_at = null, paused_from = null,
          error = jsonb_build_object('code', 'dependency_not_met', 'class', 'task',
            'message', 'A task it depends on didn''t succeed.', 'task_id', new.id)
      where t.organization_id = new.organization_id
        and (t.status = 'pending' or (t.status = 'paused' and t.paused_from = 'pending'))
        and t.id in (select d.task_id from public.task_dependencies as d where d.depends_on_task_id = new.id)
      returning t.id, t.organization_id
    )
    insert into public.execution_events (organization_id, task_id, event_type, level, message, data)
    select s.organization_id, s.id, 'task.skipped', 'warn', 'Skipped: a task it depends on didn''t succeed.',
      jsonb_build_object('dependency_task_id', new.id, 'dependency_status', new.status)
    from skipped as s;
  end if;
  return new;
end;
$$;

create trigger settle_dependent_tasks after update of status on public.tasks
  for each row
  when (old.status is distinct from new.status and new.status in ('succeeded', 'failed', 'cancelled', 'skipped'))
  execute function private.settle_dependent_tasks();

-- ---------------------------------------------------------------------------
-- 4. Assigning a task: priority, dependencies, deadline
--
-- Replaces the task_runtime version. A task that depends on unfinished tasks
-- starts "pending"; one whose dependency already failed is refused.
-- Errors: 42501 not signed in, P0002 not found / role too low / unknown
-- dependency, 55000 the employee isn't active or a dependency didn't
-- succeed, 22023 invalid input, 23514 credential-shaped text.
-- ---------------------------------------------------------------------------

drop function public.assign_employee_task(uuid, text, text, text);

create function public.assign_employee_task(
  p_employee_id uuid,
  p_title text,
  p_instructions text,
  p_idempotency_key text,
  p_priority integer default 0,
  p_depends_on uuid[] default '{}',
  p_timeout_minutes integer default 4320
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
  v_depends uuid[] := coalesce(p_depends_on, '{}');
  v_found integer;
  v_unfinished integer;
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
  if p_priority is null or p_priority not between -100 and 100 then
    raise exception 'priority must be between -100 and 100' using errcode = '22023';
  end if;
  if p_timeout_minutes is null or p_timeout_minutes not between 5 and 43200 then
    raise exception 'the deadline must be between 5 minutes and 30 days' using errcode = '22023';
  end if;
  if cardinality(v_depends) > 20 or cardinality(v_depends) <> (select count(distinct d) from unnest(v_depends) as d) then
    raise exception 'a task can depend on up to 20 different tasks' using errcode = '22023';
  end if;
  if private.text_contains_secret(p_title) or private.text_contains_secret(p_instructions) then
    raise exception 'the task contains something that looks like a credential' using errcode = '23514';
  end if;

  v_key := 'employee-task:' || p_idempotency_key;
  select t.id into v_task_id from public.tasks as t
  where t.organization_id = v_employee.organization_id and t.idempotency_key = v_key;
  if v_task_id is not null then
    if not exists (select 1 from public.tasks as t where t.id = v_task_id and t.employee_id = v_employee.id) then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return v_task_id;
  end if;

  select count(*), count(*) filter (where t.status <> 'succeeded') into v_found, v_unfinished
  from public.tasks as t
  where t.id = any (v_depends) and t.organization_id = v_employee.organization_id;
  if v_found <> cardinality(v_depends) then
    raise exception 'a task it depends on wasn''t found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.tasks as t
    where t.id = any (v_depends) and t.status in ('failed', 'cancelled', 'skipped')
  ) then
    raise exception 'a task it depends on didn''t succeed' using errcode = '55000';
  end if;

  insert into public.tasks (
    organization_id, employee_id, employee_version_id, title, instructions, source, status,
    priority, idempotency_key, max_attempts, deadline_at, created_by
  )
  values (
    v_employee.organization_id, v_employee.id, v_employee.active_version_id, btrim(p_title),
    nullif(btrim(coalesce(p_instructions, '')), ''), 'manual',
    case when v_unfinished > 0 then 'pending' else 'queued' end,
    p_priority, v_key, 3, now() + make_interval(mins => p_timeout_minutes), v_uid
  )
  on conflict (organization_id, idempotency_key) do nothing
  returning id into v_task_id;

  if v_task_id is null then
    -- A concurrent request with the same key won.
    select t.id into v_task_id from public.tasks as t
    where t.organization_id = v_employee.organization_id and t.idempotency_key = v_key
      and t.employee_id = v_employee.id;
    if v_task_id is null then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return v_task_id;
  end if;

  insert into public.task_dependencies (organization_id, task_id, depends_on_task_id)
  select v_employee.organization_id, v_task_id, d from unnest(v_depends) as d;

  insert into public.execution_events (organization_id, task_id, event_type, level, message, data)
  values (v_employee.organization_id, v_task_id,
    case when v_unfinished > 0 then 'task.pending' else 'task.queued' end, 'info',
    case when v_unfinished > 0 then format('Task assigned; waiting for %s task(s) it depends on.', v_unfinished)
      else 'Task assigned and queued.' end,
    jsonb_build_object('employee_id', v_employee.id, 'employee_version_id', v_employee.active_version_id,
      'priority', p_priority, 'depends_on', to_jsonb(v_depends), 'timeout_minutes', p_timeout_minutes));
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (v_employee.organization_id, 'user', v_uid, 'task.assigned', 'tasks', v_task_id::text,
    jsonb_build_object('employee_id', v_employee.id, 'employee_version_id', v_employee.active_version_id,
      'priority', p_priority, 'depends_on', to_jsonb(v_depends)));
  return v_task_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Claiming tasks (service role)
--
-- Replaces the task_runtime version. Adds p_task_id (claim one specific task,
-- for the engine's per-task jobs), deadlines, and pause requests of tasks
-- whose server stopped.
-- ---------------------------------------------------------------------------

drop function public.claim_employee_tasks(integer, integer);

create function public.claim_employee_tasks(
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

-- ---------------------------------------------------------------------------
-- 6. Operator controls
--
-- Errors (all): 42501 not signed in, P0002 not found / role too low,
-- 55000 the task's state doesn't allow it, 22023 invalid input.
-- ---------------------------------------------------------------------------

-- Loads an employee task for an operator, locked.
create function private.operator_task(p_task_id uuid)
returns public.tasks
language plpgsql
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_task from public.tasks as t where t.id = p_task_id for update;
  if not found or v_task.employee_id is null or not private.has_min_role(v_task.organization_id, 'operator') then
    raise exception 'task not found or role too low' using errcode = 'P0002';
  end if;
  return v_task;
end;
$$;

create function private.record_task_control(p_task public.tasks, p_event text, p_message text, p_audit text, p_data jsonb default '{}')
returns void
language sql
set search_path = ''
as $$
  insert into public.execution_events (organization_id, task_id, event_type, level, message, data)
  values (p_task.organization_id, p_task.id, p_event, 'info', p_message, p_data);
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
  values (p_task.organization_id, 'user', auth.uid(), p_audit, 'tasks', p_task.id::text, p_data);
$$;

-- Cancel: replaces the task_runtime version. Pending approvals are withdrawn
-- at once, even while the employee is mid-step (it stops at its next step).
create or replace function public.cancel_employee_task(p_task_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype := private.operator_task(p_task_id);
  v_withdrawn integer;
begin
  if v_task.status = 'running' then
    update public.tasks set cancel_requested_at = coalesce(cancel_requested_at, now()), pause_requested_at = null
    where id = v_task.id;
    v_withdrawn := private.withdraw_task_actions(v_task.id, v_task.organization_id, auth.uid());
    perform private.record_task_control(v_task, 'task.cancel_requested',
      'Cancellation requested; the task stops at its next step.', 'task.cancel_requested',
      jsonb_build_object('withdrawn_actions', v_withdrawn));
    return 'cancel_requested';
  end if;
  if v_task.status not in ('pending', 'queued', 'waiting_approval', 'blocked', 'paused') then
    raise exception 'this task has already finished' using errcode = '55000';
  end if;

  update public.task_attempts set status = 'cancelled', finished_at = greatest(now(), started_at)
  where task_attempts.task_id = v_task.id and status = 'running';
  v_withdrawn := private.withdraw_task_actions(v_task.id, v_task.organization_id, auth.uid());
  update public.tasks
  set status = 'cancelled', cancel_requested_at = coalesce(cancel_requested_at, now()), completed_at = now(),
      paused_at = null, paused_from = null, pause_requested_at = null
  where id = v_task.id;
  perform private.record_task_control(v_task, 'task.cancelled', 'Task cancelled.', 'task.cancelled',
    jsonb_build_object('withdrawn_actions', v_withdrawn));
  return 'cancelled';
end;
$$;

create function public.pause_employee_task(p_task_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype := private.operator_task(p_task_id);
begin
  if v_task.status = 'running' then
    if v_task.cancel_requested_at is not null then
      raise exception 'this task is being cancelled' using errcode = '55000';
    end if;
    update public.tasks set pause_requested_at = coalesce(pause_requested_at, now()) where id = v_task.id;
    perform private.record_task_control(v_task, 'task.pause_requested',
      'Pause requested; the task pauses after its current step.', 'task.pause_requested');
    return 'pause_requested';
  end if;
  if v_task.status not in ('pending', 'queued', 'waiting_approval', 'blocked') then
    raise exception 'only an unfinished task that isn''t paused can be paused' using errcode = '55000';
  end if;
  update public.tasks set status = 'paused', paused_from = v_task.status, paused_at = now() where id = v_task.id;
  perform private.record_task_control(v_task, 'task.paused', 'Task paused.', 'task.paused',
    jsonb_build_object('from', v_task.status));
  return 'paused';
end;
$$;

create function public.resume_employee_task(p_task_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype := private.operator_task(p_task_id);
  v_status text;
begin
  if v_task.status = 'running' and v_task.pause_requested_at is not null then
    update public.tasks set pause_requested_at = null where id = v_task.id;
    perform private.record_task_control(v_task, 'task.resumed', 'Pause withdrawn; the task keeps running.', 'task.resumed');
    return 'running';
  end if;
  if v_task.status <> 'paused' then
    raise exception 'only a paused task can be resumed' using errcode = '55000';
  end if;
  if not exists (select 1 from public.ai_employees as e where e.id = v_task.employee_id and e.status = 'active') then
    raise exception 'activate the employee before resuming its task' using errcode = '55000';
  end if;

  v_status := case v_task.paused_from
    when 'pending' then case when private.task_dependencies_met(v_task.id) then 'queued' else 'pending' end
    when 'blocked' then 'blocked'
    when 'waiting_approval' then case when exists (
        select 1 from public.tool_executions as e
        where e.task_id = v_task.id and e.status in ('proposed', 'awaiting_approval', 'approved', 'executing')
      ) then 'waiting_approval' else 'queued' end
    else 'queued'
  end;
  update public.tasks
  set status = v_status, paused_at = null, paused_from = null, pause_requested_at = null, scheduled_at = null
  where id = v_task.id;
  perform private.record_task_control(v_task, 'task.resumed', 'Task resumed.', 'task.resumed',
    jsonb_build_object('status', v_status));
  return v_status;
end;
$$;

-- Retry a failed task: a new attempt continues from the last checkpoint (so
-- actions that already ran are not repeated) with a fresh set of run limits,
-- and up to three more attempts. Failures of the task itself (refused,
-- unverifiable or reported as not done) and unrecoverable ones can't be
-- retried; assign a new task instead.
create function public.retry_employee_task(p_task_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype := private.operator_task(p_task_id);
  v_attempt_id uuid;
begin
  if v_task.status <> 'failed' then
    raise exception 'only a failed task can be retried' using errcode = '55000';
  end if;
  if v_task.error ->> 'class' = 'task'
     or v_task.error ->> 'code' in ('not_found', 'invalid_configuration', 'not_recorded') then
    raise exception 'this failure can''t be retried; assign a new task instead' using errcode = '55000';
  end if;
  if not exists (select 1 from public.ai_employees as e where e.id = v_task.employee_id and e.status = 'active') then
    raise exception 'activate the employee before retrying its task' using errcode = '55000';
  end if;

  select a.id into v_attempt_id from public.task_attempts as a
  where a.task_id = v_task.id and a.checkpoint is not null
  order by a.attempt_number desc limit 1;
  if v_attempt_id is not null then
    update public.task_attempts
    set checkpoint = checkpoint || jsonb_build_object('limitBaseline', jsonb_build_object(
      'turns', coalesce((checkpoint ->> 'turns')::integer, 0),
      'toolCalls', coalesce(jsonb_array_length(checkpoint -> 'toolCalls'), 0),
      'costMicros', coalesce((checkpoint ->> 'costMicros')::bigint, 0),
      'activeMs', coalesce((checkpoint ->> 'activeMs')::bigint, 0)))
    where id = v_attempt_id;
  end if;

  update public.tasks
  set status = 'queued', completed_at = null, error = null, scheduled_at = null, lease_expires_at = null,
      cancel_requested_at = null,
      max_attempts = least(20, attempt_count + 3),
      deadline_at = case when deadline_at is not null and deadline_at <= now()
        then now() + greatest(deadline_at - created_at, interval '5 minutes') else deadline_at end
  where id = v_task.id;
  perform private.record_task_control(v_task, 'task.retry_requested',
    'Retry requested; a new attempt continues from the last checkpoint.', 'task.retried',
    jsonb_build_object('previous_error', v_task.error -> 'code'));
  return 'queued';
end;
$$;

create function public.set_employee_task_priority(p_task_id uuid, p_priority integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype := private.operator_task(p_task_id);
begin
  if p_priority is null or p_priority not between -100 and 100 then
    raise exception 'priority must be between -100 and 100' using errcode = '22023';
  end if;
  if v_task.status in ('succeeded', 'failed', 'cancelled', 'skipped') then
    raise exception 'this task has already finished' using errcode = '55000';
  end if;
  update public.tasks set priority = p_priority where id = v_task.id;
  perform private.record_task_control(v_task, 'task.priority_changed', format('Priority set to %s.', p_priority),
    'task.priority_changed', jsonb_build_object('from', v_task.priority, 'to', p_priority));
  return p_priority;
end;
$$;

-- Reassign before any work started: the task pins the new employee's active
-- version. Once an attempt has run, its checkpoint belongs to that employee.
create function public.reassign_employee_task(p_task_id uuid, p_employee_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype := private.operator_task(p_task_id);
  v_employee public.ai_employees%rowtype;
begin
  if v_task.status not in ('pending', 'queued', 'paused') or v_task.attempt_count > 0 then
    raise exception 'only a task that hasn''t started can be reassigned' using errcode = '55000';
  end if;
  select * into v_employee from public.ai_employees as e
  where e.id = p_employee_id and e.organization_id = v_task.organization_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if v_employee.status <> 'active' or v_employee.active_version_id is null then
    raise exception 'only an active employee can be given tasks' using errcode = '55000';
  end if;
  if v_employee.id = v_task.employee_id then
    return 'unchanged';
  end if;
  update public.tasks set employee_id = v_employee.id, employee_version_id = v_employee.active_version_id
  where id = v_task.id;
  perform private.record_task_control(v_task, 'task.reassigned', 'Task reassigned.', 'task.reassigned',
    jsonb_build_object('from', v_task.employee_id, 'to', v_employee.id, 'employee_version_id', v_employee.active_version_id));
  return 'reassigned';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Timing out overdue tasks (service role)
--
-- Tasks that wait (dependencies, approval, a reply, paused) or sit in the
-- queue past their deadline fail as timed out. A running task stops itself
-- (the runner checks the deadline before every step), and a running task
-- whose server stopped is timed out when it is next claimed.
-- ---------------------------------------------------------------------------

create function public.time_out_overdue_tasks(p_limit integer default 100)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
  v_count integer := 0;
begin
  if p_limit not between 1 and 1000 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  for v_task in
    select t.* from public.tasks as t
    where t.employee_id is not null and t.deadline_at <= now()
      and t.status in ('pending', 'queued', 'waiting_approval', 'blocked', 'paused')
    order by t.deadline_at
    limit p_limit
    for update skip locked
  loop
    perform private.time_out_task(v_task);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------------

revoke all on function
  private.withdraw_task_actions(uuid, uuid, uuid),
  private.time_out_task(public.tasks),
  private.task_dependencies_met(uuid),
  private.operator_task(uuid),
  private.record_task_control(public.tasks, text, text, text, jsonb),
  public.assign_employee_task(uuid, text, text, text, integer, uuid[], integer),
  public.claim_employee_tasks(integer, integer, uuid),
  public.cancel_employee_task(uuid),
  public.pause_employee_task(uuid),
  public.resume_employee_task(uuid),
  public.retry_employee_task(uuid),
  public.set_employee_task_priority(uuid, integer),
  public.reassign_employee_task(uuid, uuid),
  public.time_out_overdue_tasks(integer)
from public, anon, authenticated;

grant execute on function
  public.assign_employee_task(uuid, text, text, text, integer, uuid[], integer),
  public.cancel_employee_task(uuid),
  public.pause_employee_task(uuid),
  public.resume_employee_task(uuid),
  public.retry_employee_task(uuid),
  public.set_employee_task_priority(uuid, integer),
  public.reassign_employee_task(uuid, uuid)
to authenticated;

grant execute on function
  public.claim_employee_tasks(integer, integer, uuid),
  public.time_out_overdue_tasks(integer),
  -- Used by the claim and sweep functions and the dependency trigger, which
  -- run as the server.
  private.withdraw_task_actions(uuid, uuid, uuid),
  private.time_out_task(public.tasks),
  private.task_dependencies_met(uuid)
to service_role;

comment on column public.tasks.deadline_at is
  'The task fails as timed out if it hasn''t finished by then (set from the assignment''s timeout).';
comment on column public.tasks.paused_from is
  'The state a paused task returns to when resumed.';

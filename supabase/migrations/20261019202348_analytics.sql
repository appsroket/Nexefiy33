-- Phase 15: analytics.
--
-- Every number on the analytics pages is computed here from rows the platform
-- already persists (tasks, attempts, approvals, audit entries, tool
-- executions, workflow runs, usage and outcome records). Nothing is entered by
-- hand and nothing is extrapolated in SQL: estimates are made in the
-- application, labelled as such, from these measured values.
--
-- 1. Outcome records from actions: when an AI employee's or a workflow's
--    action succeeds, the outcome it proves (a contact created, a lead marked
--    qualified, a note logged, a message sent) is recorded with a link to the
--    tool execution and task. Captured at success, so evidence retention, which
--    clears action payloads, never changes a count.
-- 2. Facts: one row per task, action, workflow run or outcome in a period, with
--    a flag per metric. The metric functions aggregate these flags and the
--    evidence function lists the rows behind a flag, so a number and its
--    evidence can't disagree.
-- 3. Metric functions: called by members (model usage: admins, like
--    usage_records), always for one organization and a period of at most 366
--    days. SECURITY DEFINER so that every member sees the same aggregates
--    (person interventions come from the audit log, which only admins read row
--    by row); each function checks membership itself and every query filters
--    by the organization.

-- ---------------------------------------------------------------------------
-- 1. Outcome records from succeeded actions
-- ---------------------------------------------------------------------------

alter table public.outcome_records
  add column tool_execution_id uuid,
  -- The provider's id for what the outcome is about (a contact id, a channel id),
  -- so an outcome can be counted once per thing. Never an email address or message.
  add column subject text check (char_length(subject) between 1 and 200),
  add constraint outcome_records_tool_execution_fk foreign key (tool_execution_id, organization_id)
    references public.tool_executions (id, organization_id) on delete set null (tool_execution_id);

create index outcome_records_tool_execution_idx on public.outcome_records (tool_execution_id)
  where tool_execution_id is not null;
create index outcome_records_occurred_idx on public.outcome_records (organization_id, occurred_at desc);

-- The outcomes a succeeded action proves. Mirrors ACTION_OUTCOMES in
-- src/modules/analytics/domain/outcomes.ts (a test keeps them in step).
create function private.action_outcomes(p_tool_key text, p_input jsonb, p_output jsonb)
returns table (outcome_key text, subject text, details jsonb)
language sql
immutable
set search_path = ''
as $$
  select o.outcome_key, nullif(left(o.subject, 200), ''), o.details
  from (values
    ('crm.contact_created',
      p_tool_key = 'hubspot.contacts.upsert' and p_output ->> 'result' = 'created',
      p_output ->> 'id', '{}'::jsonb),
    ('crm.lead_qualified',
      p_tool_key = 'hubspot.contacts.upsert'
        and p_input ->> 'lifecycleStage' in ('marketingqualifiedlead', 'salesqualifiedlead'),
      p_output ->> 'id', jsonb_build_object('stage', p_input ->> 'lifecycleStage')),
    ('crm.note_logged',
      p_tool_key = 'hubspot.notes.create',
      coalesce(p_output ->> 'contactId', p_input ->> 'contactId'), '{}'::jsonb),
    ('messaging.message_sent',
      p_tool_key = 'slack.messages.post',
      p_output ->> 'channel', '{}'::jsonb)
  ) as o (outcome_key, applies, subject, details)
  where o.applies;
$$;

create function private.record_action_outcomes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
begin
  if new.status <> 'succeeded' or (tg_op = 'UPDATE' and old.status = 'succeeded') then
    return null;
  end if;
  select * into v_task from public.tasks as t
  where t.id = new.task_id and t.organization_id = new.organization_id;
  -- Only AI work: an employee's task or a workflow step. A person's own action proves nothing about AI employees.
  if not found or (v_task.employee_id is null and v_task.workflow_run_id is null) then
    return null;
  end if;
  insert into public.outcome_records (organization_id, outcome_key, employee_id, task_id, workflow_run_id,
    tool_execution_id, subject, quantity, metadata, idempotency_key, occurred_at)
  select new.organization_id, o.outcome_key, coalesce(new.employee_id, v_task.employee_id), v_task.id,
    v_task.workflow_run_id, new.id, o.subject, 1, jsonb_build_object('tool_key', new.tool_key) || o.details,
    'action:' || new.id || ':' || o.outcome_key, coalesce(new.finished_at, now())
  from private.action_outcomes(new.tool_key, coalesce(new.input_redacted, '{}'::jsonb),
    coalesce(new.output_redacted, '{}'::jsonb)) as o
  on conflict (organization_id, idempotency_key) do nothing;
  return null;
end;
$$;

create trigger record_action_outcomes after insert or update of status on public.tool_executions
  for each row execute function private.record_action_outcomes();

-- Actions that succeeded before this migration.
insert into public.outcome_records (organization_id, outcome_key, employee_id, task_id, workflow_run_id,
  tool_execution_id, subject, quantity, metadata, idempotency_key, occurred_at)
select e.organization_id, o.outcome_key, coalesce(e.employee_id, t.employee_id), t.id, t.workflow_run_id, e.id,
  o.subject, 1, jsonb_build_object('tool_key', e.tool_key) || o.details,
  'action:' || e.id || ':' || o.outcome_key, coalesce(e.finished_at, e.updated_at)
from public.tool_executions as e
join public.tasks as t on t.id = e.task_id and t.organization_id = e.organization_id
cross join lateral private.action_outcomes(e.tool_key, coalesce(e.input_redacted, '{}'::jsonb),
  coalesce(e.output_redacted, '{}'::jsonb)) as o
where e.status = 'succeeded' and e.payload_purged_at is null
  and (t.employee_id is not null or t.workflow_run_id is not null)
on conflict (organization_id, idempotency_key) do nothing;

-- Person interventions on a task are read from the audit log by target.
create index audit_logs_target_idx on public.audit_logs (organization_id, target_table, target_id)
  where target_id is not null;
create index tasks_org_created_idx on public.tasks (organization_id, created_at desc);
create index workflow_runs_org_queued_idx on public.workflow_runs (organization_id, queued_at desc);

-- ---------------------------------------------------------------------------
-- 2. Facts
-- ---------------------------------------------------------------------------

create function private.analytics_check(p_organization_id uuid, p_from timestamptz, p_to timestamptz, p_min_role text default 'viewer')
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_organization_id is null or not private.has_min_role(p_organization_id, p_min_role) then
    raise exception 'not allowed to read this workspace''s analytics' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'the period must end after it starts and span at most 366 days' using errcode = '22023';
  end if;
end;
$$;

-- What a person did to a task (from the audit log, which retention never purges).
create function private.analytics_person_controls()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['task.replied', 'task.cancel_requested', 'task.cancelled', 'task.pause_requested', 'task.paused',
    'task.resumed', 'task.retried', 'task.reassigned', 'task.handed_off', 'task.completed_by_person'];
$$;

-- Employee tasks created in the period. The department is the one configured
-- on the employee version that ran the task.
create function private.analytics_task_facts(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  task_id uuid, title text, status text, created_at timestamptz, completed_at timestamptz,
  employee_id uuid, department text, workflow_id uuid, workflow_run_id uuid,
  created boolean, open boolean, finished boolean, completed boolean, verified boolean, needs_review boolean,
  failed boolean, cancelled boolean, skipped boolean, completed_by_person boolean,
  attempts integer, retried boolean, retries integer, recovery_attempted boolean, recovered boolean,
  approvals_requested integer, approvals_approved integer, approvals_rejected integer, approvals_expired integer,
  approval_decisions integer, person_controls integer, handoff boolean, intervened boolean,
  responded boolean, response_ms bigint, duration_ms bigint, active_ms bigint,
  input_tokens bigint, output_tokens bigint, cost_micros bigint, failure_class text, failure_code text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id, t.title, t.status, t.created_at, t.completed_at,
    t.employee_id, coalesce(nullif(v.config #>> '{profile,department}', ''), 'unspecified'), r.workflow_id, t.workflow_run_id,
    true,
    t.status not in ('succeeded', 'failed', 'cancelled', 'skipped'),
    t.status in ('succeeded', 'failed', 'cancelled'),
    t.status = 'succeeded' and t.handed_off_at is null,
    t.status = 'succeeded' and t.handed_off_at is null and t.result #>> '{verification,status}' = 'verified',
    t.status = 'succeeded' and t.handed_off_at is null and t.result #>> '{verification,status}' is distinct from 'verified',
    t.status = 'failed',
    t.status = 'cancelled',
    t.status = 'skipped',
    t.status = 'succeeded' and t.handed_off_at is not null,
    a.attempts,
    a.attempts > 1,
    greatest(a.attempts - 1, 0),
    a.attempts > 1 and a.had_failure and t.status in ('succeeded', 'failed', 'cancelled'),
    a.attempts > 1 and a.had_failure and t.status = 'succeeded' and t.handed_off_at is null,
    q.requested, q.approved, q.rejected, q.expired,
    q.approved + q.rejected,
    c.controls,
    t.handed_off_at is not null or t.handoff_requested_at is not null,
    q.approved + q.rejected > 0 or c.controls > 0 or t.handed_off_at is not null or t.handoff_requested_at is not null,
    m.first_message_at is not null,
    (extract(epoch from (m.first_message_at - t.created_at)) * 1000)::bigint,
    case when t.status = 'succeeded' and t.handed_off_at is null
      then (extract(epoch from (t.completed_at - t.created_at)) * 1000)::bigint end,
    a.active_ms, a.input_tokens, a.output_tokens, a.cost_micros,
    case when t.status = 'failed' then coalesce(t.error ->> 'class', 'unknown') end,
    case when t.status = 'failed' then coalesce(t.error ->> 'code', 'unknown') end
  from public.tasks as t
  left join public.employee_versions as v on v.id = t.employee_version_id and v.organization_id = t.organization_id
  left join public.workflow_runs as r on r.id = t.workflow_run_id and r.organization_id = t.organization_id
  cross join lateral (
    select count(*)::integer as attempts,
      coalesce(bool_or(x.status in ('failed', 'timed_out')), false) as had_failure,
      coalesce(sum(x.active_ms), 0)::bigint as active_ms,
      coalesce(sum(x.model_input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(x.model_output_tokens), 0)::bigint as output_tokens,
      coalesce(sum(x.cost_micros), 0)::bigint as cost_micros
    from public.task_attempts as x
    where x.task_id = t.id and x.organization_id = t.organization_id
  ) as a
  cross join lateral (
    select count(*)::integer as requested,
      (count(*) filter (where x.status = 'approved' and x.decided_by is not null))::integer as approved,
      (count(*) filter (where x.status = 'rejected' and x.decided_by is not null))::integer as rejected,
      (count(*) filter (where x.status = 'expired'))::integer as expired
    from public.approval_requests as x
    where x.task_id = t.id and x.organization_id = t.organization_id
  ) as q
  cross join lateral (
    select count(*)::integer as controls
    from public.audit_logs as l
    where l.organization_id = t.organization_id and l.target_table = 'tasks' and l.target_id = t.id::text
      and l.actor_type = 'user' and l.action = any (private.analytics_person_controls())
  ) as c
  cross join lateral (
    select min(e.finished_at) as first_message_at
    from public.tool_executions as e
    where e.task_id = t.id and e.organization_id = t.organization_id
      and e.status = 'succeeded' and e.action_category = 'external_message'
  ) as m
  where t.organization_id = p_organization_id
    and t.employee_id is not null
    and t.created_at >= p_from and t.created_at < p_to;
$$;

-- Actions requested for AI work (an employee or a workflow step) in the period.
create function private.analytics_action_facts(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  execution_id uuid, task_id uuid, tool_key text, provider text, category text, status text, error_code text,
  created_at timestamptz, finished_at timestamptz, employee_id uuid, department text, workflow_id uuid,
  requested boolean, succeeded boolean, failed boolean, settled boolean, rejected boolean, withdrawn boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.id, e.task_id, e.tool_key, split_part(e.tool_key, '.', 1), coalesce(e.action_category, 'unknown'), e.status,
    case when e.status = 'failed' then coalesce(e.error ->> 'code', 'unknown') end,
    e.created_at, e.finished_at, coalesce(e.employee_id, t.employee_id),
    case when t.employee_id is not null then coalesce(nullif(v.config #>> '{profile,department}', ''), 'unspecified') end,
    r.workflow_id,
    true,
    e.status = 'succeeded',
    e.status = 'failed',
    e.status in ('succeeded', 'failed'),
    e.status = 'rejected',
    e.status in ('cancelled', 'skipped')
  from public.tool_executions as e
  join public.tasks as t on t.id = e.task_id and t.organization_id = e.organization_id
  left join public.employee_versions as v on v.id = t.employee_version_id and v.organization_id = t.organization_id
  left join public.workflow_runs as r on r.id = t.workflow_run_id and r.organization_id = t.organization_id
  where e.organization_id = p_organization_id
    and (t.employee_id is not null or t.workflow_run_id is not null)
    and e.created_at >= p_from and e.created_at < p_to;
$$;

-- Workflow runs queued in the period.
create function private.analytics_run_facts(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  run_id uuid, workflow_id uuid, status text, trigger_type text, queued_at timestamptz, started_at timestamptz,
  finished_at timestamptz, started boolean, open boolean, finished boolean, succeeded boolean, failed boolean,
  cancelled boolean, rejected boolean, steps_failed integer, has_failed_step boolean, duration_ms bigint,
  cost_micros bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    r.id, r.workflow_id, r.status, r.trigger_type, r.queued_at, r.started_at, r.finished_at,
    true,
    r.status in ('queued', 'running', 'waiting'),
    r.status in ('succeeded', 'failed', 'cancelled', 'rejected', 'timed_out'),
    r.status = 'succeeded',
    r.status in ('failed', 'timed_out'),
    r.status = 'cancelled',
    r.status = 'rejected',
    s.failed_steps,
    s.failed_steps > 0,
    case when r.status = 'succeeded'
      then (extract(epoch from (r.finished_at - coalesce(r.started_at, r.queued_at))) * 1000)::bigint end,
    k.cost_micros
  from public.workflow_runs as r
  cross join lateral (
    select (count(*) filter (where s.status = 'failed'))::integer as failed_steps
    from public.workflow_run_steps as s
    where s.run_id = r.id and s.organization_id = r.organization_id
  ) as s
  cross join lateral (
    select coalesce(sum(x.cost_micros), 0)::bigint as cost_micros
    from public.tasks as t
    join public.task_attempts as x on x.task_id = t.id and x.organization_id = t.organization_id
    where t.workflow_run_id = r.id and t.organization_id = r.organization_id
  ) as k
  where r.organization_id = p_organization_id
    and r.queued_at >= p_from and r.queued_at < p_to;
$$;

-- Outcomes recorded in the period.
create function private.analytics_outcome_facts(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  outcome_id uuid, outcome_key text, subject text, quantity numeric, occurred_at timestamptz, task_id uuid,
  tool_execution_id uuid, employee_id uuid, department text, workflow_id uuid, workflow_run_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id, o.outcome_key, o.subject, o.quantity, o.occurred_at, o.task_id, o.tool_execution_id, o.employee_id,
    case when o.employee_id is not null
      then coalesce(nullif(v.config #>> '{profile,department}', ''), 'unspecified') end,
    r.workflow_id, o.workflow_run_id
  from public.outcome_records as o
  left join public.tasks as t on t.id = o.task_id and t.organization_id = o.organization_id
  left join public.employee_versions as v on v.id = t.employee_version_id and v.organization_id = o.organization_id
  left join public.workflow_runs as r on r.id = o.workflow_run_id and r.organization_id = o.organization_id
  where o.organization_id = p_organization_id
    and o.occurred_at >= p_from and o.occurred_at < p_to;
$$;

-- ---------------------------------------------------------------------------
-- 3. Metrics (aggregates of the facts) and evidence (the rows behind a flag)
-- ---------------------------------------------------------------------------

create function public.analytics_task_metrics(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  grain text, key text,
  tasks_created bigint, tasks_open bigint, tasks_finished bigint, tasks_completed bigint, tasks_verified bigint,
  tasks_needs_review bigint, tasks_failed bigint, tasks_cancelled bigint, tasks_skipped bigint,
  tasks_completed_by_person bigint, tasks_retried bigint, retries bigint, recovery_attempted bigint,
  tasks_recovered bigint, approvals_requested bigint, approvals_approved bigint, approvals_rejected bigint,
  approvals_expired bigint, tasks_intervened bigint, person_controls bigint, tasks_handoff bigint,
  tasks_responded bigint, response_p50_ms bigint, duration_p50_ms bigint, duration_p90_ms bigint,
  active_p50_ms bigint, active_ms bigint, input_tokens bigint, output_tokens bigint, cost_micros bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.analytics_check(p_organization_id, p_from, p_to);
  return query
  select * from (
    select
      case when grouping(f.department) = 0 then 'department'
           when grouping(f.employee_id) = 0 then 'employee'
           when grouping(f.workflow_id) = 0 then 'workflow'
           else 'organization' end,
      case when grouping(f.department) = 0 then f.department
           when grouping(f.employee_id) = 0 then f.employee_id::text
           when grouping(f.workflow_id) = 0 then f.workflow_id::text
           else p_organization_id::text end,
      count(*), count(*) filter (where f.open), count(*) filter (where f.finished),
      count(*) filter (where f.completed), count(*) filter (where f.verified),
      count(*) filter (where f.needs_review), count(*) filter (where f.failed),
      count(*) filter (where f.cancelled), count(*) filter (where f.skipped),
      count(*) filter (where f.completed_by_person), count(*) filter (where f.retried),
      coalesce(sum(f.retries), 0)::bigint, count(*) filter (where f.recovery_attempted),
      count(*) filter (where f.recovered), coalesce(sum(f.approvals_requested), 0)::bigint,
      coalesce(sum(f.approvals_approved), 0)::bigint, coalesce(sum(f.approvals_rejected), 0)::bigint,
      coalesce(sum(f.approvals_expired), 0)::bigint, count(*) filter (where f.intervened),
      coalesce(sum(f.person_controls), 0)::bigint, count(*) filter (where f.handoff),
      count(*) filter (where f.responded),
      (percentile_cont(0.5) within group (order by f.response_ms))::bigint,
      (percentile_cont(0.5) within group (order by f.duration_ms))::bigint,
      (percentile_cont(0.9) within group (order by f.duration_ms))::bigint,
      (percentile_cont(0.5) within group (order by f.active_ms) filter (where f.completed))::bigint,
      coalesce(sum(f.active_ms), 0)::bigint, coalesce(sum(f.input_tokens), 0)::bigint,
      coalesce(sum(f.output_tokens), 0)::bigint, coalesce(sum(f.cost_micros), 0)::bigint
    from private.analytics_task_facts(p_organization_id, p_from, p_to) as f
    group by grouping sets ((), (f.department), (f.employee_id), (f.workflow_id))
  ) as m (grain, key)
  where m.grain = 'organization' or m.key is not null;
end;
$$;

create function public.analytics_task_failures(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (grain text, key text, failure_class text, failure_code text, tasks bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.analytics_check(p_organization_id, p_from, p_to);
  return query
  select * from (
    select
      case when grouping(f.department) = 0 then 'department'
           when grouping(f.employee_id) = 0 then 'employee'
           when grouping(f.workflow_id) = 0 then 'workflow'
           else 'organization' end,
      case when grouping(f.department) = 0 then f.department
           when grouping(f.employee_id) = 0 then f.employee_id::text
           when grouping(f.workflow_id) = 0 then f.workflow_id::text
           else p_organization_id::text end,
      f.failure_class, f.failure_code, count(*)
    from private.analytics_task_facts(p_organization_id, p_from, p_to) as f
    where f.failed
    group by grouping sets ((f.failure_class, f.failure_code), (f.department, f.failure_class, f.failure_code),
      (f.employee_id, f.failure_class, f.failure_code), (f.workflow_id, f.failure_class, f.failure_code))
  ) as m (grain, key)
  where m.grain = 'organization' or m.key is not null;
end;
$$;

create function public.analytics_action_metrics(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  grain text, key text, error_code text,
  actions_requested bigint, actions_succeeded bigint, actions_failed bigint, actions_settled bigint,
  actions_rejected bigint, actions_withdrawn bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.analytics_check(p_organization_id, p_from, p_to);
  return query
  select * from (
    select
      case when grouping(f.department) = 0 then 'department'
           when grouping(f.employee_id) = 0 then 'employee'
           when grouping(f.workflow_id) = 0 then 'workflow'
           when grouping(f.provider) = 0 and grouping(f.error_code) = 0 then 'provider_error'
           when grouping(f.provider) = 0 then 'provider'
           else 'organization' end,
      case when grouping(f.department) = 0 then f.department
           when grouping(f.employee_id) = 0 then f.employee_id::text
           when grouping(f.workflow_id) = 0 then f.workflow_id::text
           when grouping(f.provider) = 0 then f.provider
           else p_organization_id::text end,
      case when grouping(f.error_code) = 0 then f.error_code end,
      count(*), count(*) filter (where f.succeeded), count(*) filter (where f.failed),
      count(*) filter (where f.settled), count(*) filter (where f.rejected), count(*) filter (where f.withdrawn)
    from private.analytics_action_facts(p_organization_id, p_from, p_to) as f
    group by grouping sets ((), (f.department), (f.employee_id), (f.workflow_id), (f.provider), (f.provider, f.error_code))
  ) as m (grain, key, error_code)
  where (m.grain = 'organization' or m.key is not null)
    and (m.grain <> 'provider_error' or m.error_code is not null);
end;
$$;

create function public.analytics_workflow_metrics(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  grain text, key text, runs_started bigint, runs_open bigint, runs_finished bigint, runs_succeeded bigint,
  runs_failed bigint, runs_cancelled bigint, runs_rejected bigint, runs_with_failed_step bigint, steps_failed bigint,
  duration_p50_ms bigint, duration_p90_ms bigint, cost_micros bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.analytics_check(p_organization_id, p_from, p_to);
  return query
  select * from (
    select
      case when grouping(f.workflow_id) = 0 then 'workflow' else 'organization' end,
      case when grouping(f.workflow_id) = 0 then f.workflow_id::text else p_organization_id::text end,
      count(*), count(*) filter (where f.open), count(*) filter (where f.finished),
      count(*) filter (where f.succeeded), count(*) filter (where f.failed), count(*) filter (where f.cancelled),
      count(*) filter (where f.rejected), count(*) filter (where f.has_failed_step),
      coalesce(sum(f.steps_failed), 0)::bigint,
      (percentile_cont(0.5) within group (order by f.duration_ms))::bigint,
      (percentile_cont(0.9) within group (order by f.duration_ms))::bigint,
      coalesce(sum(f.cost_micros), 0)::bigint
    from private.analytics_run_facts(p_organization_id, p_from, p_to) as f
    group by grouping sets ((), (f.workflow_id))
  ) as m (grain, key);
end;
$$;

create function public.analytics_outcome_metrics(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (grain text, key text, outcome_key text, records bigint, quantity numeric, subjects bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.analytics_check(p_organization_id, p_from, p_to);
  return query
  select * from (
    select
      case when grouping(f.department) = 0 then 'department'
           when grouping(f.employee_id) = 0 then 'employee'
           when grouping(f.workflow_id) = 0 then 'workflow'
           else 'organization' end,
      case when grouping(f.department) = 0 then f.department
           when grouping(f.employee_id) = 0 then f.employee_id::text
           when grouping(f.workflow_id) = 0 then f.workflow_id::text
           else p_organization_id::text end,
      f.outcome_key, count(*), coalesce(sum(f.quantity), 0), count(distinct f.subject)
    from private.analytics_outcome_facts(p_organization_id, p_from, p_to) as f
    group by grouping sets ((f.outcome_key), (f.department, f.outcome_key), (f.employee_id, f.outcome_key),
      (f.workflow_id, f.outcome_key))
  ) as m (grain, key)
  where m.grain = 'organization' or m.key is not null;
end;
$$;

-- All model usage in the period, including test runs (admins only, like usage_records).
create function public.analytics_model_usage(p_organization_id uuid, p_from timestamptz, p_to timestamptz)
returns table (source text, model text, cost_micros bigint, input_tokens bigint, output_tokens bigint, calls bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.analytics_check(p_organization_id, p_from, p_to, 'admin');
  return query
  select
    case when u.task_id is not null or u.idempotency_key like 'task:%' then 'tasks'
         when u.idempotency_key like 'employee-test:%' then 'tests'
         else 'other' end as src,
    coalesce(u.model, 'unknown') as mdl,
    coalesce(sum(u.cost_micros) filter (where u.metric = 'model_cost'), 0)::bigint,
    coalesce(sum(u.quantity) filter (where u.metric = 'model_input_tokens'), 0)::bigint,
    coalesce(sum(u.quantity) filter (where u.metric = 'model_output_tokens'), 0)::bigint,
    count(*) filter (where u.metric = 'model_cost')
  from public.usage_records as u
  where u.organization_id = p_organization_id
    and u.metric in ('model_cost', 'model_input_tokens', 'model_output_tokens')
    and u.occurred_at >= p_from and u.occurred_at < p_to
  group by 1, 2
  order by 1, 2;
end;
$$;

-- Whether one fact row is behind a flag, in a scope. A flag is a boolean column
-- or a count above zero; for outcomes it is the outcome key.
create function private.analytics_matches(p_item jsonb, p_source text, p_flag text, p_grain text, p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    case
      when p_source = 'outcome' then p_item ->> 'outcome_key' = p_flag
      when jsonb_typeof(p_item -> p_flag) = 'boolean' then (p_item ->> p_flag)::boolean
      when jsonb_typeof(p_item -> p_flag) = 'number' then (p_item ->> p_flag)::numeric > 0
      else false
    end
    and coalesce(case p_grain
      when 'organization' then true
      when 'department' then p_item ->> 'department' = p_key
      when 'employee' then p_item ->> 'employee_id' = p_key
      when 'workflow' then p_item ->> 'workflow_id' = p_key
      when 'provider' then p_item ->> 'provider' = p_key
      when 'provider_error' then (p_item ->> 'provider') || ':' || (p_item ->> 'error_code') = p_key
      else false
    end, false);
$$;

-- The rows behind one flag of one fact source, for one scope. The flag is a
-- column of the facts (a boolean, or a count that must be above zero); for
-- outcomes it is the outcome key.
create function public.analytics_evidence(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_source text,
  p_flag text,
  p_grain text default 'organization',
  p_key text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (item jsonb, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.analytics_check(p_organization_id, p_from, p_to);
  if p_source not in ('task', 'action', 'run', 'outcome') then
    raise exception 'unknown evidence source' using errcode = '22023';
  end if;
  if p_flag is null or p_flag !~ '^[a-z][a-z0-9_.]{0,79}$' then
    raise exception 'unknown metric' using errcode = '22023';
  end if;
  if p_grain not in ('organization', 'department', 'employee', 'workflow', 'provider', 'provider_error')
     or (p_grain <> 'organization' and p_key is null) then
    raise exception 'unknown scope' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 then
    raise exception 'page out of range' using errcode = '22023';
  end if;

  if p_source = 'task' then
    return query
    select m.item, count(*) over () from (
      select to_jsonb(f) as item, f.created_at as at, f.task_id::text as sort_id
      from private.analytics_task_facts(p_organization_id, p_from, p_to) as f
    ) as m
    where private.analytics_matches(m.item, p_source, p_flag, p_grain, p_key)
    order by m.at desc, m.sort_id limit p_limit offset p_offset;
  elsif p_source = 'action' then
    return query
    select m.item, count(*) over () from (
      select to_jsonb(f) as item, f.created_at as at, f.execution_id::text as sort_id
      from private.analytics_action_facts(p_organization_id, p_from, p_to) as f
    ) as m
    where private.analytics_matches(m.item, p_source, p_flag, p_grain, p_key)
    order by m.at desc, m.sort_id limit p_limit offset p_offset;
  elsif p_source = 'run' then
    return query
    select m.item, count(*) over () from (
      select to_jsonb(f) as item, f.queued_at as at, f.run_id::text as sort_id
      from private.analytics_run_facts(p_organization_id, p_from, p_to) as f
    ) as m
    where private.analytics_matches(m.item, p_source, p_flag, p_grain, p_key)
    order by m.at desc, m.sort_id limit p_limit offset p_offset;
  else
    return query
    select m.item, count(*) over () from (
      select to_jsonb(f) as item, f.occurred_at as at, f.outcome_id::text as sort_id
      from private.analytics_outcome_facts(p_organization_id, p_from, p_to) as f
    ) as m
    where private.analytics_matches(m.item, p_source, p_flag, p_grain, p_key)
    order by m.at desc, m.sort_id limit p_limit offset p_offset;
  end if;
end;
$$;

revoke all on function
  private.action_outcomes(text, jsonb, jsonb),
  private.record_action_outcomes(),
  private.analytics_check(uuid, timestamptz, timestamptz, text),
  private.analytics_person_controls(),
  private.analytics_matches(jsonb, text, text, text, text),
  private.analytics_task_facts(uuid, timestamptz, timestamptz),
  private.analytics_action_facts(uuid, timestamptz, timestamptz),
  private.analytics_run_facts(uuid, timestamptz, timestamptz),
  private.analytics_outcome_facts(uuid, timestamptz, timestamptz),
  public.analytics_task_metrics(uuid, timestamptz, timestamptz),
  public.analytics_task_failures(uuid, timestamptz, timestamptz),
  public.analytics_action_metrics(uuid, timestamptz, timestamptz),
  public.analytics_workflow_metrics(uuid, timestamptz, timestamptz),
  public.analytics_outcome_metrics(uuid, timestamptz, timestamptz),
  public.analytics_model_usage(uuid, timestamptz, timestamptz),
  public.analytics_evidence(uuid, timestamptz, timestamptz, text, text, text, text, integer, integer)
from public, anon, authenticated;

grant execute on function
  public.analytics_task_metrics(uuid, timestamptz, timestamptz),
  public.analytics_task_failures(uuid, timestamptz, timestamptz),
  public.analytics_action_metrics(uuid, timestamptz, timestamptz),
  public.analytics_workflow_metrics(uuid, timestamptz, timestamptz),
  public.analytics_outcome_metrics(uuid, timestamptz, timestamptz),
  public.analytics_model_usage(uuid, timestamptz, timestamptz),
  public.analytics_evidence(uuid, timestamptz, timestamptz, text, text, text, text, integer, integer)
to authenticated;

comment on function public.analytics_evidence(uuid, timestamptz, timestamptz, text, text, text, text, integer, integer) is
  'The task, action, run or outcome rows counted by one analytics metric (docs/analytics.md).';

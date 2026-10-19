-- Durable execution: priority, dependencies (release and skip), deadlines,
-- pause and resume, retry with a fresh set of limits, cancellation that
-- withdraws pending approvals mid-step, reassignment before work starts,
-- claiming one specific task, and who may do each of these.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- BEGIN FIXTURE two_organizations
-- Shared fixture (copied verbatim into each behavioral test file; keep in sync).
-- Two organizations. A has one user per role; B has an owner. Plus an outsider.
-- Each organization gets one row in every tenant table.
--
-- Users                                   Org A                                   Org B
--   a0..01 owner-a   a0..02 admin-a         a1000000-0000-4000-8000-000000000000    b1000000-0000-4000-8000-000000000000
--   a0..03 operator-a a0..04 viewer-a
--   b0..01 owner-b   c0..01 outsider
-- Per-org ids: <p>2..01 employee, <p>2..02 employee version, <p>3..01 knowledge source,
--   <p>4..01 integration, <p>5..01 workflow, <p>5..02 workflow version, <p>6..01 run,
--   <p>7..01 task, <p>8..01 tool execution, <p>9..01 approval, <p>b..01 custom skill
--   where <p> is 'a' or 'b' (e.g. a2000000-0000-4000-8000-000000000001).

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a@example.test', now(), '{"full_name": "Owner A"}'),
  ('a0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'admin-a@example.test', now(), '{"full_name": "Admin A"}'),
  ('a0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'operator-a@example.test', now(), '{"full_name": "Operator A"}'),
  ('a0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'viewer-a@example.test', now(), '{"full_name": "Viewer A"}'),
  ('b0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-b@example.test', now(), '{"full_name": "Owner B"}'),
  ('c0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'outsider@example.test', now(), '{"full_name": "Outsider"}');

insert into public.organizations (id, name, slug, created_by) values
  ('a1000000-0000-4000-8000-000000000000', 'Org A', 'org-a-test', 'a0000000-0000-4000-8000-000000000001'),
  ('b1000000-0000-4000-8000-000000000000', 'Org B', 'org-b-test', 'b0000000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role) values
  ('a1000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'owner'),
  ('a1000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000002', 'admin'),
  ('a1000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000003', 'operator'),
  ('a1000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000004', 'viewer'),
  ('b1000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000001', 'owner');

do $fixture$
declare
  p text;
  org uuid;
  id_of text := '000000-0000-4000-8000-00000000000';
begin
  foreach p in array array['a', 'b'] loop
    org := (p || '1' || id_of || '0')::uuid;
    insert into public.company_settings (organization_id) values (org);
    insert into public.ai_employees (id, organization_id, name, role_category)
      values ((p || '2' || id_of || '1')::uuid, org, 'Support Agent', 'support');
    insert into public.employee_versions (id, organization_id, employee_id, instructions, config)
      values ((p || '2' || id_of || '2')::uuid, org, (p || '2' || id_of || '1')::uuid, 'Answer support questions.',
        '{"modelTier": "balanced", "limits": {"maxTurnsPerTask": 10, "maxToolCallsPerTask": 10, "maxCostUsdPerTask": 1}}');
    update public.ai_employees set current_version_id = (p || '2' || id_of || '2')::uuid, status = 'active',
      active_version_id = (p || '2' || id_of || '2')::uuid, activated_at = now()
      where id = (p || '2' || id_of || '1')::uuid;
    insert into public.skills (id, organization_id, key, name, category)
      values ((p || 'b' || id_of || '1')::uuid, org, 'custom.followup', 'Follow-up', 'custom');
    insert into public.employee_skills (organization_id, employee_id, skill_id)
      values (org, (p || '2' || id_of || '1')::uuid, (p || 'b' || id_of || '1')::uuid);
    insert into public.knowledge_sources (id, organization_id, name, source_type, status)
      values ((p || '3' || id_of || '1')::uuid, org, 'FAQ', 'text', 'ready');
    insert into public.knowledge_chunks (organization_id, source_id, chunk_index, content, content_sha256, embedding, embedding_model)
      values (org, (p || '3' || id_of || '1')::uuid, 0, 'Refunds are accepted within 30 days.', repeat('a', 64),
        array_fill(0.01::real, array[1024])::extensions.vector, 'voyage-4');
    insert into public.integrations (id, organization_id, provider, display_name, status, external_account_id, connected_at)
      values ((p || '4' || id_of || '1')::uuid, org, 'google', 'Support inbox', 'connected', 'acct-' || p, now());
    insert into public.integration_secrets (integration_id, organization_id, secret_kind, ciphertext, key_id)
      values ((p || '4' || id_of || '1')::uuid, org, 'oauth_tokens', 'nxf1.k1.aaaa.bbbb.cccc', 'k1');
    insert into public.integration_actions (organization_id, integration_id, action_key, risk_level)
      values (org, (p || '4' || id_of || '1')::uuid, 'gmail.send', 'write_external');
    insert into public.employee_tool_permissions (organization_id, employee_id, tool_key, integration_id)
      values (org, (p || '2' || id_of || '1')::uuid, 'gmail.send', (p || '4' || id_of || '1')::uuid);
    insert into public.workflow_definitions (id, organization_id, name)
      values ((p || '5' || id_of || '1')::uuid, org, 'Reply to email');
    insert into public.workflow_versions (id, organization_id, workflow_id, graph)
      values ((p || '5' || id_of || '2')::uuid, org, (p || '5' || id_of || '1')::uuid,
        '{"nodes": [{"id": "draft", "type": "employee_task"}, {"id": "approve", "type": "approval"}],
          "edges": [{"source": "draft", "target": "approve"}]}');
    update public.workflow_definitions set current_version_id = (p || '5' || id_of || '2')::uuid, status = 'active'
      where id = (p || '5' || id_of || '1')::uuid;
    insert into public.workflow_triggers (organization_id, workflow_id, trigger_type)
      values (org, (p || '5' || id_of || '1')::uuid, 'manual');
    insert into public.workflow_runs (id, organization_id, workflow_id, workflow_version_id, trigger_type, status, idempotency_key, started_at)
      values ((p || '6' || id_of || '1')::uuid, org, (p || '5' || id_of || '1')::uuid, (p || '5' || id_of || '2')::uuid,
        'manual', 'running', 'run-1', now());
    insert into public.tasks (id, organization_id, workflow_run_id, node_id, employee_id, employee_version_id, title, source, status, idempotency_key)
      values ((p || '7' || id_of || '1')::uuid, org, (p || '6' || id_of || '1')::uuid, 'draft',
        (p || '2' || id_of || '1')::uuid, (p || '2' || id_of || '2')::uuid, 'Draft reply', 'workflow', 'waiting_approval', 'task-1');
    insert into public.task_attempts (organization_id, task_id, attempt_number)
      values (org, (p || '7' || id_of || '1')::uuid, 1);
    insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
        input_redacted, input_sha256, status, policy_decision, idempotency_key)
      values ((p || '8' || id_of || '1')::uuid, org, (p || '7' || id_of || '1')::uuid, (p || '2' || id_of || '1')::uuid,
        (p || '4' || id_of || '1')::uuid, 'gmail.send', 'write_external', '{"to": "customer@example.test"}',
        repeat('1', 64), 'awaiting_approval', 'require_approval', 'tool-1');
    insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, workflow_run_id, employee_id,
        employee_version_id, workflow_version_id, action_summary, proposed_action, payload_sha256, expires_at)
      values ((p || '9' || id_of || '1')::uuid, org, (p || '8' || id_of || '1')::uuid, (p || '7' || id_of || '1')::uuid,
        (p || '6' || id_of || '1')::uuid, (p || '2' || id_of || '1')::uuid, (p || '2' || id_of || '2')::uuid,
        (p || '5' || id_of || '2')::uuid, 'Send reply to customer', '{"to": "customer@example.test"}', repeat('1', 64),
        now() + interval '1 day');
    insert into public.execution_events (organization_id, task_id, event_type, message)
      values (org, (p || '7' || id_of || '1')::uuid, 'task.started', 'Task started');
    insert into public.organization_policies (organization_id, name, policy)
      values (org, 'Default', '{"rules": [{"effect": "require_approval", "riskLevels": ["write_external"]}]}');
    insert into public.subscriptions (organization_id, plan_key, provider, status, currency)
      values (org, 'trial', 'manual', 'trialing', 'USD');
    insert into public.usage_records (organization_id, metric, quantity, cost_micros, currency, idempotency_key)
      values (org, 'model_cost', 1, 1500, 'USD', 'usage-1');
    insert into public.outcome_records (organization_id, outcome_key, employee_id)
      values (org, 'support.ticket_resolved', (p || '2' || id_of || '1')::uuid);
  end loop;
end;
$fixture$;
-- END FIXTURE two_organizations

create temp table t_ids (label text primary key, id uuid not null);
grant all on t_ids to public;

-- A second active employee in organization A (for reassignment).
insert into public.ai_employees (id, organization_id, name, role_category)
  values ('a2000000-0000-4000-8000-000000000011', 'a1000000-0000-4000-8000-000000000000', 'Sales Agent', 'sales');
insert into public.employee_versions (id, organization_id, employee_id, instructions, config)
  values ('a2000000-0000-4000-8000-000000000012', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000011',
    'Qualify leads.', '{"modelTier": "balanced", "limits": {"maxTurnsPerTask": 10, "maxToolCallsPerTask": 10, "maxCostUsdPerTask": 1}}');
update public.ai_employees set current_version_id = 'a2000000-0000-4000-8000-000000000012', status = 'active',
  active_version_id = 'a2000000-0000-4000-8000-000000000012', activated_at = now()
  where id = 'a2000000-0000-4000-8000-000000000011';

-- Assigning with priority, dependencies and a deadline -----------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Too urgent', null, 'key-prio-0001', 500) $$,
  '22023', null, 'priority must be between -100 and 100'
);
select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Too quick', null, 'key-time-0001', 0, '{}', 1) $$,
  '22023', null, 'the deadline must be at least 5 minutes away'
);
select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Theirs', null, 'key-deps-0001', 0,
       array['b7000000-0000-4000-8000-000000000001']::uuid[]) $$,
  'P0002', null, 'a task cannot depend on another organization''s task'
);

insert into t_ids select 'first', public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Look up Jane', null, 'key-first-001', 10);
insert into t_ids select 'second', public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Update Jane', null, 'key-second-01', 50,
  array[(select id from t_ids where label = 'first')], 60);
insert into t_ids select 'third', public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Tell sales', null, 'key-third-001', 0,
  array[(select id from t_ids where label = 'second')]);
insert into t_ids select 'low', public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Low priority', null, 'key-low-00001', -5);

select ok(
  (select t.status = 'queued' and t.priority = 10 and t.deadline_at between now() + interval '2 days 23 hours' and now() + interval '3 days 1 minute'
   from public.tasks as t where t.id = (select id from t_ids where label = 'first')),
  'a task without dependencies is queued, with its priority and a default 3-day deadline'
);
select ok(
  (select t.status = 'pending' and t.deadline_at <= now() + interval '61 minutes'
   from public.tasks as t where t.id = (select id from t_ids where label = 'second')),
  'a task whose dependency hasn''t finished waits as pending, with its own deadline'
);
select is(
  (select count(*)::int from public.task_dependencies where task_id = (select id from t_ids where label = 'second')),
  1, 'the dependency is recorded'
);
select ok(
  exists (select 1 from public.execution_events where task_id = (select id from t_ids where label = 'second') and event_type = 'task.pending'),
  'a pending task records why it waits'
);

-- Claiming: priority order, and one specific task ----------------------------------

reset role;
set local role service_role;
select is(
  (select task_id from public.claim_employee_tasks(1, 60)),
  (select id from t_ids where label = 'first'),
  'the highest-priority queued task is claimed first (the pending one is not claimable)'
);
select is(
  (select count(*)::int from public.claim_employee_tasks(5, 60, (select id from t_ids where label = 'second'))),
  0, 'a pending task cannot be claimed by id'
);
select is(
  (select task_id from public.claim_employee_tasks(5, 60, (select id from t_ids where label = 'low'))),
  (select id from t_ids where label = 'low'),
  'a specific queued task can be claimed by id'
);

-- Dependencies: success releases, failure skips (transitively) ---------------------

reset role;
update public.tasks set status = 'succeeded', lease_expires_at = null, completed_at = now()
  where id = (select id from t_ids where label = 'first');
select ok(
  (select t.status = 'queued' from public.tasks as t where t.id = (select id from t_ids where label = 'second'))
  and exists (select 1 from public.execution_events where task_id = (select id from t_ids where label = 'second') and event_type = 'task.dependencies_met'),
  'when its dependency succeeds, a pending task is queued'
);
select ok(
  (select t.status = 'pending' from public.tasks as t where t.id = (select id from t_ids where label = 'third')),
  'a task further down the chain keeps waiting'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.cancel_employee_task((select id from t_ids where label = 'second')), 'cancelled', 'an operator cancels a queued task');
select ok(
  (select t.status = 'skipped' and t.error ->> 'code' = 'dependency_not_met' and t.completed_at is not null
   from public.tasks as t where t.id = (select id from t_ids where label = 'third')),
  'a task whose dependency was cancelled is skipped'
);
select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'After a cancelled task', null, 'key-after-cncl', 0,
       array[(select id from t_ids where label = 'second')]) $$,
  '55000', null, 'a new task cannot depend on a task that didn''t succeed'
);

-- Pause and resume -------------------------------------------------------------------

insert into t_ids select 'pausable', public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Pause me', null, 'key-pause-001');
select is(public.pause_employee_task((select id from t_ids where label = 'pausable')), 'paused', 'an operator pauses a queued task');
select ok(
  (select t.status = 'paused' and t.paused_from = 'queued' and t.paused_at is not null
   from public.tasks as t where t.id = (select id from t_ids where label = 'pausable')),
  'a paused task remembers where it was'
);
select throws_ok(
  $$ select public.pause_employee_task((select id from t_ids where label = 'pausable')) $$,
  '55000', null, 'a paused task cannot be paused again'
);
reset role;
set local role service_role;
select is(
  (select count(*)::int from public.claim_employee_tasks(5, 60, (select id from t_ids where label = 'pausable'))),
  0, 'a paused task is not claimed'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.resume_employee_task((select id from t_ids where label = 'pausable')) $$,
  'P0002', null, 'a viewer cannot resume a task'
);
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.pause_employee_task((select id from t_ids where label = 'pausable')) $$,
  'P0002', null, 'another organization''s owner cannot control the task'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.resume_employee_task((select id from t_ids where label = 'pausable')), 'queued', 'resuming returns the task to the queue');
select ok(
  (select t.paused_at is null and t.paused_from is null from public.tasks as t where t.id = (select id from t_ids where label = 'pausable')),
  'a resumed task is no longer marked paused'
);

-- Pausing a running task waits for its current step.
reset role;
set local role service_role;
select is(
  (select count(*)::int from public.claim_employee_tasks(5, 60, (select id from t_ids where label = 'pausable'))),
  1, 'the resumed task is claimed'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.pause_employee_task((select id from t_ids where label = 'pausable')), 'pause_requested', 'pausing a running task is a request');
select is(public.resume_employee_task((select id from t_ids where label = 'pausable')), 'running', 'the request can be withdrawn while it runs');
select is(public.pause_employee_task((select id from t_ids where label = 'pausable')), 'pause_requested', 'and requested again');
-- Its server stops: the next claim pauses it instead of running it.
reset role;
update public.tasks set lease_expires_at = now() - interval '1 second' where id = (select id from t_ids where label = 'pausable');
set local role service_role;
select is(
  (select count(*)::int from public.claim_employee_tasks(5, 60, (select id from t_ids where label = 'pausable'))),
  0, 'a task whose pause was requested is not run again'
);
reset role;
select ok(
  (select t.status = 'paused' and t.paused_from = 'queued' and t.lease_expires_at is null
   from public.tasks as t where t.id = (select id from t_ids where label = 'pausable'))
  and (select a.status = 'timed_out' from public.task_attempts as a where a.task_id = (select id from t_ids where label = 'pausable')),
  'it is paused, and the lost attempt ends as timed out'
);

-- An employee paused in the meantime must be reactivated first.
update public.ai_employees set status = 'paused' where id = 'a2000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.resume_employee_task((select id from t_ids where label = 'pausable')) $$,
  '55000', null, 'a task cannot resume while its employee is paused'
);
reset role;
update public.ai_employees set status = 'active' where id = 'a2000000-0000-4000-8000-000000000001';

-- A task paused while it waited for a reply returns to waiting for it.
insert into t_ids values ('blocked', 'a7000000-0000-4000-8000-0000000000b1');
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key, attempt_count, started_at)
  values ('a7000000-0000-4000-8000-0000000000b1', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Ask first', 'manual', 'blocked', 'employee-task:blocked', 1, now());
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.pause_employee_task('a7000000-0000-4000-8000-0000000000b1'), 'paused', 'a task waiting for a reply can be paused');
select is(public.resume_employee_task('a7000000-0000-4000-8000-0000000000b1'), 'blocked', 'and resumes waiting for the reply');

-- Cancelling a running task withdraws its pending approvals at once -------------------

reset role;
insert into t_ids values ('running', 'a7000000-0000-4000-8000-0000000000c1');
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    attempt_count, started_at, lease_expires_at)
  values ('a7000000-0000-4000-8000-0000000000c1', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Busy', 'manual', 'running', 'employee-task:running', 1, now(), now() + interval '5 minutes');
insert into public.task_attempts (organization_id, task_id, attempt_number)
  values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000c1', 1);
insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    input_redacted, input_sha256, status, policy_decision, idempotency_key)
  values
    ('a8000000-0000-4000-8000-0000000000c1', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000c1',
     'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
     '{}', repeat('4', 64), 'awaiting_approval', 'require_approval', 'task:running:1'),
    ('a8000000-0000-4000-8000-0000000000c2', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000c1',
     'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
     '{}', repeat('5', 64), 'succeeded', 'allow', 'task:running:2');
insert into public.approval_requests (organization_id, tool_execution_id, task_id, employee_id, action_summary, proposed_action, payload_sha256, expires_at)
  values ('a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-0000000000c1', 'a7000000-0000-4000-8000-0000000000c1',
    'a2000000-0000-4000-8000-000000000001', 'Send it', '{}', repeat('4', 64), now() + interval '1 day');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.cancel_employee_task('a7000000-0000-4000-8000-0000000000c1'), 'cancel_requested', 'cancelling a running task is a request');
select ok(
  (select e.status = 'cancelled' from public.tool_executions as e where e.id = 'a8000000-0000-4000-8000-0000000000c1')
  and (select a.status = 'cancelled' from public.approval_requests as a where a.tool_execution_id = 'a8000000-0000-4000-8000-0000000000c1'),
  'its pending approval is withdrawn immediately, so it can no longer be approved'
);
select ok(
  (select e.status = 'succeeded' from public.tool_executions as e where e.id = 'a8000000-0000-4000-8000-0000000000c2'),
  'an action that already ran stays recorded as done'
);
select throws_ok(
  $$ select public.pause_employee_task('a7000000-0000-4000-8000-0000000000c1') $$,
  '55000', null, 'a task being cancelled cannot be paused'
);

-- Retrying a failed task ----------------------------------------------------------------

reset role;
insert into t_ids values ('failed', 'a7000000-0000-4000-8000-0000000000d1');
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    attempt_count, max_attempts, started_at, completed_at, error, created_at, deadline_at)
  values ('a7000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Ran out', 'manual', 'failed', 'employee-task:failed', 3, 3,
    now() - interval '2 hours', now() - interval '1 hour',
    '{"code": "limit_reached", "class": "limit", "message": "Stopped after 10 steps."}',
    now() - interval '3 hours', now() - interval '30 minutes');
insert into public.task_attempts (organization_id, task_id, attempt_number, status, finished_at, error, checkpoint, started_at)
  values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d1', 3, 'failed', now() - interval '1 hour',
    '{"code": "limit_reached"}', '{"version": 1, "turns": 10, "toolCalls": [{"toolKey": "a.b"}, {"toolKey": "a.b"}], "costMicros": 5000, "activeMs": 9000}',
    now() - interval '2 hours');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.retry_employee_task('a7000000-0000-4000-8000-0000000000d1') $$,
  'P0002', null, 'a viewer cannot retry a task'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.retry_employee_task('a7000000-0000-4000-8000-0000000000d1'), 'queued', 'an operator retries a failed task');
reset role;
select ok(
  (select t.status = 'queued' and t.error is null and t.completed_at is null and t.max_attempts = 6 and t.deadline_at > now()
   from public.tasks as t where t.id = 'a7000000-0000-4000-8000-0000000000d1'),
  'the retried task is queued with three more attempts and a new deadline'
);
select is(
  (select a.checkpoint -> 'limitBaseline' from public.task_attempts as a where a.task_id = 'a7000000-0000-4000-8000-0000000000d1'),
  '{"turns": 10, "toolCalls": 2, "costMicros": 5000, "activeMs": 9000}'::jsonb,
  'the checkpoint records where the fresh run limits start'
);
update public.tasks set status = 'failed', completed_at = now(),
  error = '{"code": "verification_failed", "class": "task", "message": "Report did not match."}'
  where id = 'a7000000-0000-4000-8000-0000000000d1';
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.retry_employee_task('a7000000-0000-4000-8000-0000000000d1') $$,
  '55000', null, 'a task whose result failed verification cannot be retried'
);

-- Priority and reassignment ---------------------------------------------------------------

select is(public.set_employee_task_priority((select id from t_ids where label = 'low'), 20), 20, 'an operator changes an unfinished task''s priority');
select throws_ok(
  $$ select public.set_employee_task_priority((select id from t_ids where label = 'first'), 5) $$,
  '55000', null, 'a finished task''s priority cannot change'
);

insert into t_ids select 'unstarted', public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Not started', null, 'key-reassign-1');
select is(
  public.reassign_employee_task((select id from t_ids where label = 'unstarted'), 'a2000000-0000-4000-8000-000000000011'),
  'reassigned', 'a task that hasn''t started can be reassigned'
);
select ok(
  (select t.employee_id = 'a2000000-0000-4000-8000-000000000011' and t.employee_version_id = 'a2000000-0000-4000-8000-000000000012'
   from public.tasks as t where t.id = (select id from t_ids where label = 'unstarted')),
  'it pins the new employee''s active version'
);
select throws_ok(
  $$ select public.reassign_employee_task((select id from t_ids where label = 'unstarted'), 'b2000000-0000-4000-8000-000000000001') $$,
  'P0002', null, 'a task cannot be reassigned to another organization''s employee'
);
select throws_ok(
  $$ select public.reassign_employee_task((select id from t_ids where label = 'pausable'), 'a2000000-0000-4000-8000-000000000011') $$,
  '55000', null, 'a task that already ran cannot be reassigned'
);

-- Deadlines ----------------------------------------------------------------------------------

reset role;
insert into t_ids values ('overdue', 'a7000000-0000-4000-8000-0000000000e1');
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    attempt_count, started_at, created_at, deadline_at)
  values ('a7000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Too slow', 'manual', 'waiting_approval', 'employee-task:overdue', 1,
    now() - interval '2 hours', now() - interval '3 hours', now() - interval '1 minute');
insert into public.task_attempts (organization_id, task_id, attempt_number)
  values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e1', 1);
insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    input_redacted, input_sha256, status, policy_decision, idempotency_key)
  values ('a8000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e1',
    'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
    '{}', repeat('6', 64), 'awaiting_approval', 'require_approval', 'task:overdue:1');
insert into t_ids values ('late_queue', 'a7000000-0000-4000-8000-0000000000e2');
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key, created_at, deadline_at)
  values ('a7000000-0000-4000-8000-0000000000e2', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Queued too long', 'manual', 'queued', 'employee-task:late-queue',
    now() - interval '3 hours', now() - interval '1 minute');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok($$ select public.time_out_overdue_tasks(10) $$, '42501', null, 'clients cannot run the deadline sweep');

reset role;
set local role service_role;
select is(public.time_out_overdue_tasks(100), 2, 'overdue waiting and queued tasks are timed out');
reset role;
select ok(
  (select t.status = 'failed' and t.error ->> 'code' = 'deadline_passed' and t.error ->> 'class' = 'limit'
   from public.tasks as t where t.id = 'a7000000-0000-4000-8000-0000000000e1')
  and (select a.status = 'timed_out' from public.task_attempts as a where a.task_id = 'a7000000-0000-4000-8000-0000000000e1')
  and (select e.status = 'cancelled' from public.tool_executions as e where e.id = 'a8000000-0000-4000-8000-0000000000e1'),
  'a timed-out task fails, its attempt ends, and its pending action is withdrawn'
);
select ok(
  exists (select 1 from public.execution_events where task_id = 'a7000000-0000-4000-8000-0000000000e1' and event_type = 'task.timed_out'),
  'the timeout is in the task''s history'
);

-- A running task whose server stopped after its deadline is timed out when claimed.
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    attempt_count, started_at, lease_expires_at, created_at, deadline_at)
  values ('a7000000-0000-4000-8000-0000000000e3', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Lost and late', 'manual', 'running', 'employee-task:lost-late', 1,
    now() - interval '2 hours', now() - interval '1 second', now() - interval '3 hours', now() - interval '1 minute');
set local role service_role;
select is(
  (select count(*)::int from public.claim_employee_tasks(5, 60, 'a7000000-0000-4000-8000-0000000000e3')),
  0, 'a lost task past its deadline is not run again'
);
reset role;
select ok(
  (select t.status = 'failed' and t.error ->> 'code' = 'deadline_passed' from public.tasks as t where t.id = 'a7000000-0000-4000-8000-0000000000e3'),
  'it fails as timed out'
);

-- Structural rules ------------------------------------------------------------------------------

select throws_ok(
  $$ update public.tasks set status = 'paused' where id = (select id from t_ids where label = 'low') $$,
  '23514', null, 'a paused task must record when and from where it was paused'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_employee_tasks(integer, integer, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.pause_employee_task(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.retry_employee_task(uuid)', 'EXECUTE'),
  'operators control tasks through the functions; only the server claims them'
);

select * from finish();
rollback;

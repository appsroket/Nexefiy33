-- Task runtime: assigning tasks to active employees (roles, organization,
-- idempotency, credential-shaped text), claiming with leases and attempts,
-- recovering a lost attempt, re-queueing after an approval decision,
-- cancelling and replying, expiring approvals, evidence and checkpoints
-- readable only as intended.
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

-- Assigning --------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Find Jane', null, 'key-viewer-0001') $$,
  'P0002', null,
  'a viewer cannot assign tasks'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.assign_employee_task('b2000000-0000-4000-8000-000000000001', 'Find Jane', null, 'key-cross-0001') $$,
  'P0002', null,
  'an operator cannot assign tasks to another organization''s employee'
);
select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Use sk-ant-abcdef123456', null, 'key-secret-001') $$,
  '23514', null,
  'credential-shaped task text is refused'
);
select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', '   ', null, 'key-empty-0001') $$,
  '22023', null,
  'a task needs a title'
);
select lives_ok(
  $$ insert into t_ids select 'task', public.assign_employee_task('a2000000-0000-4000-8000-000000000001',
       'Find Jane in the CRM', 'Look up jane@example.test.', 'key-task-00001') $$,
  'an operator assigns a task to an active employee'
);
select is(
  public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Find Jane in the CRM', 'Look up jane@example.test.', 'key-task-00001'),
  (select id from t_ids where label = 'task'),
  'repeating the idempotency key returns the same task'
);
select ok(
  (select t.status = 'queued' and t.source = 'manual' and t.employee_version_id = 'a2000000-0000-4000-8000-000000000002'
     and t.created_by = 'a0000000-0000-4000-8000-000000000003' and t.max_attempts = 3
   from public.tasks as t where t.id = (select id from t_ids where label = 'task')),
  'the task is queued, pinned to the active version, and records who assigned it'
);
select ok(
  exists (select 1 from public.execution_events where task_id = (select id from t_ids where label = 'task') and event_type = 'task.queued'),
  'assigning records a task.queued event the operator can read'
);
select throws_ok(
  $$ update public.tasks set status = 'succeeded', completed_at = now() where id = (select id from t_ids where label = 'task') $$,
  '42501', null,
  'clients cannot change a task directly'
);
select throws_ok(
  $$ select public.claim_employee_tasks(5, 60) $$,
  '42501', null,
  'clients cannot claim tasks'
);
select throws_ok(
  $$ select public.expire_overdue_approvals(10) $$,
  '42501', null,
  'clients cannot run the approval expiry'
);

reset role;
update public.ai_employees set status = 'paused' where id = 'a2000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'Find Jane', null, 'key-paused-001') $$,
  '55000', null,
  'a paused employee cannot be given tasks'
);
reset role;
update public.ai_employees set status = 'active' where id = 'a2000000-0000-4000-8000-000000000001';

-- Claiming (service role) ------------------------------------------------------

set local role service_role;
create temp table t_claim as select * from public.claim_employee_tasks(5, 60);
select is((select count(*)::int from t_claim), 1, 'the queued employee task is claimed (the waiting fixture task is not)');
select ok(
  (select c.task_id = (select id from t_ids where label = 'task') and c.new_attempt and not c.recovered and c.attempt_number = 1 from t_claim as c),
  'the first claim starts attempt 1'
);
select ok(
  (select t.status = 'running' and t.lease_expires_at > now() and t.attempt_count = 1 and t.started_at is not null
   from public.tasks as t where t.id = (select id from t_ids where label = 'task')),
  'a claimed task is running under a lease'
);
select is((select count(*)::int from public.claim_employee_tasks(5, 60)), 0, 'a leased task is not claimed twice');
select throws_ok(
  $$ update public.tasks set lease_expires_at = null where id = (select id from t_ids where label = 'task') $$,
  '23514', null,
  'a running employee task must hold a lease'
);

-- The server stops: the lease expires and the attempt is replaced.
update public.task_attempts set checkpoint = '{"messages": [], "turns": 1}', checkpoint_at = now()
  where task_id = (select id from t_ids where label = 'task');
update public.tasks set lease_expires_at = now() - interval '1 second' where id = (select id from t_ids where label = 'task');
create temp table t_recover as select * from public.claim_employee_tasks(5, 60);
select ok(
  (select c.recovered and c.new_attempt and c.attempt_number = 2 from t_recover as c),
  'an expired lease is recovered with a new attempt'
);
select ok(
  (select a.status = 'timed_out' and a.error ->> 'code' = 'worker_lost'
   from public.task_attempts as a where a.task_id = (select id from t_ids where label = 'task') and a.attempt_number = 1),
  'the lost attempt ends as timed out'
);

-- Out of attempts: the third loss fails the task.
update public.tasks set lease_expires_at = now() - interval '1 second' where id = (select id from t_ids where label = 'task');
select is((select attempt_number::int from public.claim_employee_tasks(5, 60)), 3, 'the second loss starts attempt 3');
update public.tasks set lease_expires_at = now() - interval '1 second' where id = (select id from t_ids where label = 'task');
select is((select count(*)::int from public.claim_employee_tasks(5, 60)), 0, 'a task out of attempts is not claimed again');
select ok(
  (select t.status = 'failed' and t.error ->> 'code' = 'attempts_exhausted' and t.completed_at is not null and t.lease_expires_at is null
   from public.tasks as t where t.id = (select id from t_ids where label = 'task')),
  'a task that lost every attempt fails'
);

-- Waiting for an approval and resuming ------------------------------------------

reset role;
insert into t_ids values ('waiting', 'a7000000-0000-4000-8000-0000000000aa');
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key, attempt_count, started_at)
  values ('a7000000-0000-4000-8000-0000000000aa', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Create Jane', 'manual', 'waiting_approval', 'employee-task:waiting', 1, now());
insert into public.task_attempts (organization_id, task_id, attempt_number, checkpoint)
  values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000aa', 1, '{"messages": []}');
insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    input_redacted, input_sha256, status, policy_decision, idempotency_key)
  values
    ('a8000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000aa',
     'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
     '{}', repeat('2', 64), 'awaiting_approval', 'require_approval', 'task:waiting:1'),
    ('a8000000-0000-4000-8000-0000000000a2', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000aa',
     'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
     '{}', repeat('3', 64), 'awaiting_approval', 'require_approval', 'task:waiting:2');
insert into public.approval_requests (organization_id, tool_execution_id, task_id, employee_id, action_summary, proposed_action, payload_sha256, expires_at)
  values
    ('a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-0000000000a1', 'a7000000-0000-4000-8000-0000000000aa',
     'a2000000-0000-4000-8000-000000000001', 'Send one', '{}', repeat('2', 64), now() + interval '1 day'),
    ('a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-0000000000a2', 'a7000000-0000-4000-8000-0000000000aa',
     'a2000000-0000-4000-8000-000000000001', 'Send two', '{}', repeat('3', 64), now() + interval '1 day');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select lives_ok(
  $$ select public.decide_approval((select id from public.approval_requests where tool_execution_id = 'a8000000-0000-4000-8000-0000000000a1'),
       'rejected', repeat('2', 64)) $$,
  'the owner rejects the first proposed action'
);
select is(
  (select status from public.tasks where id = 'a7000000-0000-4000-8000-0000000000aa'),
  'waiting_approval',
  'the task keeps waiting while another of its actions is pending'
);
select lives_ok(
  $$ select public.decide_approval((select id from public.approval_requests where tool_execution_id = 'a8000000-0000-4000-8000-0000000000a2'),
       'rejected', repeat('3', 64)) $$,
  'the owner rejects the second proposed action'
);
select is(
  (select status from public.tasks where id = 'a7000000-0000-4000-8000-0000000000aa'),
  'queued',
  'when its last pending action is decided, the task is queued to continue'
);

reset role;
set local role service_role;
create temp table t_resume as select * from public.claim_employee_tasks(5, 60);
select ok(
  (select not c.new_attempt and not c.recovered and c.attempt_number = 1 from t_resume as c
   where c.task_id = 'a7000000-0000-4000-8000-0000000000aa'),
  'a resumed task continues its running attempt (waiting uses no retry)'
);

-- Replying and cancelling -------------------------------------------------------

reset role;
update public.tasks set status = 'blocked', lease_expires_at = null where id = 'a7000000-0000-4000-8000-0000000000aa';
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.reply_to_employee_task('a7000000-0000-4000-8000-0000000000aa', 'Use the work email.') $$,
  'P0002', null,
  'a viewer cannot reply to an employee'
);
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.reply_to_employee_task('a7000000-0000-4000-8000-0000000000aa', 'Use the work email.') $$,
  'P0002', null,
  'another organization''s owner cannot reply'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  public.reply_to_employee_task('a7000000-0000-4000-8000-0000000000aa', 'Use the work email.'),
  'queued',
  'an operator answers an escalated task and it is queued'
);
select throws_ok(
  $$ select checkpoint from public.task_attempts where task_id = 'a7000000-0000-4000-8000-0000000000aa' $$,
  '42501', null,
  'clients cannot read checkpoints'
);
select ok(
  (select a.turn_count = 0 from public.task_attempts as a where a.task_id = 'a7000000-0000-4000-8000-0000000000aa'),
  'members still read the other attempt columns'
);
reset role;
select is(
  (select checkpoint -> 'requesterReply' ->> 'text' from public.task_attempts where task_id = 'a7000000-0000-4000-8000-0000000000aa' and status = 'running'),
  'Use the work email.',
  'the reply is stored in the checkpoint for the runtime'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.cancel_employee_task('a7000000-0000-4000-8000-0000000000aa'), 'cancelled', 'an operator cancels a queued task');
select ok(
  (select t.status = 'cancelled' and t.completed_at is not null from public.tasks as t where t.id = 'a7000000-0000-4000-8000-0000000000aa')
  and (select a.status = 'cancelled' from public.task_attempts as a where a.task_id = 'a7000000-0000-4000-8000-0000000000aa'),
  'the task and its attempt are cancelled'
);
select throws_ok(
  $$ select public.cancel_employee_task('a7000000-0000-4000-8000-0000000000aa') $$,
  '55000', null,
  'a finished task cannot be cancelled again'
);
select throws_ok(
  $$ select public.cancel_employee_task('b7000000-0000-4000-8000-000000000001') $$,
  'P0002', null,
  'an operator cannot cancel another organization''s task'
);
select is(
  public.cancel_employee_task('a7000000-0000-4000-8000-000000000001'),
  'cancelled',
  'cancelling a waiting task also cancels its pending approval'
);
select ok(
  (select a.status = 'cancelled' from public.approval_requests as a where a.id = 'a9000000-0000-4000-8000-000000000001')
  and (select e.status = 'cancelled' from public.tool_executions as e where e.id = 'a8000000-0000-4000-8000-000000000001'),
  'the waiting task''s approval and tool execution are cancelled'
);

-- Expiring approvals --------------------------------------------------------------

reset role;
update public.approval_requests set expires_at = created_at + interval '1 millisecond'
  where id = 'b9000000-0000-4000-8000-000000000001';
set local role service_role;
select is(public.expire_overdue_approvals(10), 1, 'an overdue approval is expired');
reset role;
select ok(
  (select a.status = 'expired' and a.decided_at is not null from public.approval_requests as a where a.id = 'b9000000-0000-4000-8000-000000000001')
  and (select e.status = 'cancelled' from public.tool_executions as e where e.id = 'b8000000-0000-4000-8000-000000000001')
  and (select t.status = 'queued' from public.tasks as t where t.id = 'b7000000-0000-4000-8000-000000000001'),
  'its action is cancelled and the employee task is queued to continue'
);

-- Evidence ----------------------------------------------------------------------------

insert into public.task_evidence (organization_id, task_id, kind, tool_key, title, excerpt)
  values
    ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001', 'tool_result', 'hubspot.contacts.search', 'HubSpot: Find contacts', '1 contact'),
    ('b1000000-0000-4000-8000-000000000000', 'b7000000-0000-4000-8000-000000000001', 'knowledge_passage', null, 'Refund policy', 'Refunds within 30 days');
select throws_ok(
  $$ insert into public.task_evidence (organization_id, task_id, kind, title, excerpt)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001', 'knowledge_passage', 'Leak', 'key sk-ant-abcdef123456') $$,
  '23514', null,
  'evidence cannot store credential-shaped text'
);
select throws_ok(
  $$ update public.task_evidence set title = 'Changed' where task_id = 'a7000000-0000-4000-8000-000000000001' $$,
  null, null,
  'evidence is immutable'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is((select count(*)::int from public.task_evidence), 1, 'a member reads only their organization''s evidence');
select throws_ok(
  $$ insert into public.task_evidence (organization_id, task_id, kind, title)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001', 'knowledge_passage', 'Forged') $$,
  '42501', null,
  'clients cannot write evidence'
);
set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is((select count(*)::int from public.task_evidence), 0, 'an outsider reads no evidence');

select * from finish();
rollback;

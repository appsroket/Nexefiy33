-- Integration framework: OAuth state and rate-limit tables are server-only,
-- the pending input of a tool execution is hidden from clients and cannot be
-- replaced, rate-limit windows stay inside one organization, and the executor
-- queue only hands out approved or abandoned executions.
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

-- Structure --------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.integration_oauth_states'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.integration_rate_limit_windows'::regclass),
  'new integration tables have RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.integration_oauth_states', 'SELECT')
  and not has_table_privilege('authenticated', 'public.integration_oauth_states', 'INSERT')
  and not has_table_privilege('anon', 'public.integration_oauth_states', 'SELECT')
  and not has_table_privilege('authenticated', 'public.integration_rate_limit_windows', 'SELECT')
  and not has_table_privilege('authenticated', 'public.integration_rate_limit_windows', 'INSERT'),
  'clients have no access to OAuth states or rate-limit windows'
);
select ok(
  not has_column_privilege('authenticated', 'public.tool_executions', 'pending_input', 'SELECT')
  and has_column_privilege('authenticated', 'public.tool_executions', 'input_redacted', 'SELECT')
  and has_column_privilege('authenticated', 'public.tool_executions', 'status', 'SELECT'),
  'members can read tool executions except their pending input'
);
select ok(
  not has_column_privilege('authenticated', 'public.integrations', 'health_status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.integrations', 'status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.integration_secrets', 'refresh_lease_until', 'UPDATE'),
  'clients cannot write connection health, status or refresh leases'
);
select ok(
  not has_function_privilege('authenticated', 'public.consume_integration_rate_limit(uuid, uuid, text, integer, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.consume_integration_rate_limit(uuid, uuid, text, integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_tool_executions(integer, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_tool_executions(integer, integer)', 'EXECUTE'),
  'only the service role can consume rate limits or claim executions'
);

-- Constraints (as the migration owner) -------------------------------------------

select throws_ok(
  $$ insert into public.integration_oauth_states (organization_id, provider, user_id, state_sha256, return_path, expires_at)
     values ('a1000000-0000-4000-8000-000000000000', 'hubspot', 'a0000000-0000-4000-8000-000000000002',
       repeat('c', 64), 'https://evil.example/app', now() + interval '10 minutes') $$,
  '23514', null,
  'an OAuth state can only return to a path inside the app'
);
select throws_ok(
  $$ insert into public.integration_oauth_states (organization_id, provider, user_id, state_sha256, expires_at)
     values ('a1000000-0000-4000-8000-000000000000', 'hubspot', 'a0000000-0000-4000-8000-000000000002',
       repeat('d', 64), now() + interval '2 hours') $$,
  '23514', null,
  'an OAuth state cannot live longer than an hour'
);
select throws_ok(
  $$ insert into public.integration_oauth_states (organization_id, provider, user_id, state_sha256, integration_id, expires_at)
     values ('a1000000-0000-4000-8000-000000000000', 'hubspot', 'a0000000-0000-4000-8000-000000000002',
       repeat('e', 64), 'b4000000-0000-4000-8000-000000000001', now() + interval '10 minutes') $$,
  '23503', null,
  'an OAuth state cannot point at another organization''s connection'
);
select throws_ok(
  $$ update public.integrations set health_message = 'token xoxb-not-a-real-token'
     where id = 'a4000000-0000-4000-8000-000000000001' $$,
  '23514', null,
  'health messages cannot contain credentials'
);

-- Pending input -----------------------------------------------------------------

insert into public.tasks (id, organization_id, title, source, status, idempotency_key)
values ('a7000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'Post to Slack', 'manual', 'running', 'task-2');
insert into public.tool_executions (id, organization_id, task_id, integration_id, tool_key, risk_level, input_redacted,
    input_sha256, status, policy_decision, idempotency_key, pending_input, requested_by)
values ('a8000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000002',
  'a4000000-0000-4000-8000-000000000001', 'slack.messages.post', 'write_external', '{"channel": "C1"}', repeat('2', 64),
  'awaiting_approval', 'require_approval', 'tool-2', '{"channel": "C1", "text": "Hello"}', 'a0000000-0000-4000-8000-000000000003');

select throws_ok(
  $$ update public.tool_executions set pending_input = '{"channel": "C1", "text": "Changed"}'
     where id = 'a8000000-0000-4000-8000-000000000002' $$,
  '42501', null,
  'the pending input cannot be replaced after it is recorded'
);
update public.tool_executions set status = 'rejected' where id = 'a8000000-0000-4000-8000-000000000002';
select ok(
  (select pending_input is null and lease_expires_at is null from public.tool_executions where id = 'a8000000-0000-4000-8000-000000000002'),
  'the pending input is cleared automatically when an execution ends'
);
select throws_ok(
  $$ insert into public.tool_executions (organization_id, task_id, tool_key, risk_level, input_sha256, status,
       policy_decision, idempotency_key, pending_input)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000002', 'slack.messages.post',
       'write_external', repeat('7', 64), 'failed', 'allow', 'tool-7', '{"text": "Hi"}') $$,
  '23514', null,
  'a finished execution cannot be recorded with a pending input'
);
select throws_ok(
  $$ insert into public.tool_executions (organization_id, task_id, tool_key, risk_level, input_sha256, status,
       policy_decision, idempotency_key, pending_input)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000002', 'slack.messages.post',
       'write_external', repeat('3', 64), 'proposed', 'allow', 'tool-3', '{"text": "key sk-ant-abcdefghijklmnop"}') $$,
  '23514', null,
  'pending input cannot contain credentials'
);
select throws_ok(
  $$ insert into public.tool_executions (organization_id, task_id, tool_key, risk_level, input_sha256, status,
       policy_decision, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000002', 'slack.messages.post',
       'write_external', repeat('4', 64), 'executing', 'allow', 'tool-4') $$,
  '23514', null,
  'an executing action must hold a lease'
);

-- Clients cannot read the pending input.
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select pending_input from public.tool_executions $$,
  '42501', null,
  'even an owner cannot read pending inputs through the API'
);
select is(
  (select count(*)::integer from public.tool_executions where organization_id = 'a1000000-0000-4000-8000-000000000000'),
  2,
  'members still read their organization''s tool executions'
);
select is(
  (select count(*)::integer from public.tool_executions where organization_id = 'b1000000-0000-4000-8000-000000000000'),
  0,
  'members cannot read another organization''s tool executions'
);
reset role;

-- Rate limits --------------------------------------------------------------------

set local role service_role;
select is(
  (select allowed from public.consume_integration_rate_limit(
    'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 'default', 2, 3600)),
  true, 'the first request in a window is allowed'
);
select is(
  (select allowed from public.consume_integration_rate_limit(
    'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 'default', 2, 3600)),
  true, 'requests up to the limit are allowed'
);
select ok(
  (select not allowed and retry_after_ms > 0 from public.consume_integration_rate_limit(
    'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 'default', 2, 3600)),
  'a request over the limit is refused with a retry delay'
);
select is(
  (select allowed from public.consume_integration_rate_limit(
    'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 'search', 2, 3600)),
  true, 'buckets are counted separately'
);
select throws_ok(
  $$ select * from public.consume_integration_rate_limit(
       'b1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 'default', 2, 3600) $$,
  'P0002', null,
  'another organization cannot consume (or learn about) a connection''s window'
);
select throws_ok(
  $$ select * from public.consume_integration_rate_limit(
       'b1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 'other', 2, 3600) $$,
  '23503', null,
  'a window cannot be created for another organization''s connection'
);
select throws_ok(
  $$ select * from public.consume_integration_rate_limit(
       'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 'default', 0, 10) $$,
  '22023', null,
  'a limit must be positive'
);

-- Execution queue ------------------------------------------------------------------
reset role;

-- Org A: an approved execution waiting to run, and one whose lease expired.
insert into public.tool_executions (id, organization_id, task_id, integration_id, tool_key, risk_level, input_sha256,
    status, policy_decision, idempotency_key, pending_input)
values ('a8000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000002',
  'a4000000-0000-4000-8000-000000000001', 'slack.messages.post', 'write_external', repeat('5', 64), 'awaiting_approval',
  'require_approval', 'tool-5', '{"channel": "C1", "text": "Approved"}');
insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, action_summary, proposed_action,
    payload_sha256, expires_at)
values ('a9000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-000000000005',
  'a7000000-0000-4000-8000-000000000002', 'Post to #sales', '{"channel": "C1"}', repeat('5', 64), now() + interval '1 day');
update public.approval_requests set status = 'approved', decided_at = now() where id = 'a9000000-0000-4000-8000-000000000005';
update public.tool_executions set status = 'approved' where id = 'a8000000-0000-4000-8000-000000000005';

insert into public.tool_executions (id, organization_id, task_id, integration_id, tool_key, risk_level, input_sha256,
    status, policy_decision, idempotency_key, lease_expires_at, attempt_count, started_at, pending_input)
values ('a8000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000002',
  'a4000000-0000-4000-8000-000000000001', 'hubspot.contacts.search', 'read', repeat('6', 64), 'executing', 'allow', 'tool-6',
  now() - interval '1 minute', 1, now() - interval '5 minutes', '{"query": "dana"}');

set local role service_role;
create temporary table claimed on commit drop as
  select * from public.claim_tool_executions(10, 120);

select is(
  (select count(*)::integer from claimed), 2,
  'the queue hands out approved executions and expired leases only'
);
select ok(
  (select not recovered and attempt = 1 from claimed where tool_execution_id = 'a8000000-0000-4000-8000-000000000005'),
  'an approved execution is claimed as a first attempt'
);
select ok(
  (select recovered and attempt = 2 from claimed where tool_execution_id = 'a8000000-0000-4000-8000-000000000006'),
  'an execution with an expired lease is reported as recovered'
);
select ok(
  (select bool_and(status = 'executing' and lease_expires_at > now()) from public.tool_executions
   where id in ('a8000000-0000-4000-8000-000000000005', 'a8000000-0000-4000-8000-000000000006')),
  'claimed executions are leased'
);
select is(
  (select count(*)::integer from public.claim_tool_executions(10, 120)), 0,
  'a leased execution is not handed out twice'
);
select is(
  (select status from public.tool_executions where id = 'a8000000-0000-4000-8000-000000000001'), 'awaiting_approval',
  'executions still waiting for approval are never claimed'
);
reset role;

-- An execution that needs approval cannot be claimed into running without one.
update public.tool_executions set status = 'approved' where id = 'a8000000-0000-4000-8000-000000000001';
set local role service_role;
select throws_ok(
  $$ select * from public.claim_tool_executions(10, 120) $$,
  '42501', null,
  'the queue cannot start an execution whose approval is missing'
);
reset role;

-- decide_approval still works with the new columns: rejecting clears the input.
insert into public.tool_executions (id, organization_id, task_id, integration_id, tool_key, risk_level, input_sha256,
    status, policy_decision, idempotency_key, pending_input)
values ('a8000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000002',
  'a4000000-0000-4000-8000-000000000001', 'slack.messages.post', 'write_external', repeat('8', 64), 'awaiting_approval',
  'require_approval', 'tool-8', '{"channel": "C1", "text": "Reject me"}');
insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, action_summary, proposed_action,
    payload_sha256, expires_at, required_role)
values ('a9000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-000000000008',
  'a7000000-0000-4000-8000-000000000002', 'Post to #sales', '{"channel": "C1"}', repeat('8', 64), now() + interval '1 day', 'admin');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-000000000008', 'approved', repeat('8', 64)) $$,
  'P0002', null,
  'an operator cannot decide a request that needs an admin'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select lives_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-000000000008', 'rejected', repeat('8', 64)) $$,
  'an admin can reject it'
);
reset role;
select ok(
  (select status = 'rejected' and pending_input is null from public.tool_executions where id = 'a8000000-0000-4000-8000-000000000008'),
  'rejecting through decide_approval clears the pending input'
);

select * from finish();
rollback;

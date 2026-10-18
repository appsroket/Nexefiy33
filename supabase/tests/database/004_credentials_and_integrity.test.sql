-- Credentials, data integrity, approval binding, and the audit log.
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

-- Integration credentials ------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select throws_ok('select ciphertext from public.integration_secrets', '42501', null,
  'even an owner cannot read stored credentials');
select throws_ok(
  $$ insert into public.integration_secrets (integration_id, organization_id, secret_kind, ciphertext, key_id)
     values ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'api_key',
       'nxf1.k1.aaaa.bbbb.cccc', 'k1') $$,
  '42501', null, 'clients cannot write credentials'
);
select throws_ok(
  $$ insert into public.integrations (organization_id, provider, display_name)
     values ('a1000000-0000-4000-8000-000000000000', 'google', 'Planted') $$,
  '42501', null, 'clients cannot create integration connections directly (OAuth callback only)'
);

set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';

select is((select count(*)::int from public.integration_secrets), 2, 'the server (service role) can read credentials');
select throws_ok(
  $$ insert into public.integration_secrets (integration_id, organization_id, secret_kind, ciphertext, key_id)
     values ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'api_key',
       'ya29.plaintext-access-token', 'k1') $$,
  '23514', null, 'plaintext credentials are rejected; only encrypted envelopes are stored'
);
select throws_ok(
  $$ insert into public.integration_secrets (integration_id, organization_id, secret_kind, ciphertext, key_id)
     values ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'api_key',
       'nxf1.k2.aaaa.bbbb.cccc', 'k1') $$,
  '23514', null, 'the recorded key id must match the envelope'
);
select throws_ok(
  $$ insert into public.integration_secrets (integration_id, organization_id, secret_kind, ciphertext, key_id)
     values ('b4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'api_key',
       'nxf1.k1.aaaa.bbbb.cccc', 'k1') $$,
  '23503', null, 'a credential cannot be attached to another organization''s integration'
);

-- Configuration never holds provider secrets ----------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select throws_ok(
  $$ insert into public.employee_versions (organization_id, employee_id, instructions, config)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'x',
       '{"modelTier": "fast", "apiKey": "abc", "limits": {"maxTurnsPerTask": 1, "maxToolCallsPerTask": 0, "maxCostUsdPerTask": 1}}') $$,
  '23514', null, 'employee config rejects credential-named keys'
);
select throws_ok(
  $$ insert into public.employee_versions (organization_id, employee_id, instructions, config)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'x',
       '{"modelTier": "fast", "model": "sk-ant-api03-abcdef", "limits": {"maxTurnsPerTask": 1, "maxToolCallsPerTask": 0, "maxCostUsdPerTask": 1}}') $$,
  '23514', null, 'employee config rejects credential-shaped values'
);
select throws_ok(
  $$ insert into public.employee_versions (organization_id, employee_id, instructions, config)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
       'Use key sb_secret_abc123 when calling the API.',
       '{"modelTier": "fast", "limits": {"maxTurnsPerTask": 1, "maxToolCallsPerTask": 0, "maxCostUsdPerTask": 1}}') $$,
  '23514', null, 'employee instructions reject credential-shaped values'
);
select throws_ok(
  $$ insert into public.workflow_triggers (organization_id, workflow_id, trigger_type, config)
     values ('a1000000-0000-4000-8000-000000000000', 'a5000000-0000-4000-8000-000000000001', 'manual',
       '{"headers": {"Authorization": "Bearer x"}}') $$,
  '23514', null, 'workflow trigger config rejects credentials'
);

-- Versioned JSON schemas and valid statuses ------------------------------------------
select throws_ok(
  $$ insert into public.employee_versions (organization_id, employee_id, instructions, config)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'x',
       '{"modelTier": "enormous", "limits": {"maxTurnsPerTask": 1, "maxToolCallsPerTask": 0, "maxCostUsdPerTask": 1}}') $$,
  '23514', null, 'employee config must match its JSON schema'
);
select throws_ok(
  $$ insert into public.employee_versions (organization_id, employee_id, instructions, config_schema_version, config)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'x', 99,
       '{"modelTier": "fast", "limits": {"maxTurnsPerTask": 1, "maxToolCallsPerTask": 0, "maxCostUsdPerTask": 1}}') $$,
  '23514', null, 'unknown config schema versions are rejected'
);
select throws_ok(
  $$ update public.ai_employees set status = 'sleeping' where id = 'a2000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'invalid employee statuses are rejected'
);
insert into public.ai_employees (organization_id, name, role_category)
  values ('a1000000-0000-4000-8000-000000000000', 'New hire', 'sales');
select throws_ok(
  $$ update public.ai_employees set status = 'active' where name = 'New hire' $$,
  '23514', null, 'an employee cannot be activated without a configuration version'
);
select throws_ok(
  $$ update public.ai_employees set current_version_id = 'b2000000-0000-4000-8000-000000000002'
     where name = 'New hire' $$,
  '23503', null, 'an employee cannot point at another employee''s configuration version'
);
select throws_ok(
  $$ insert into public.workflow_definitions (organization_id, name, draft_graph)
     values ('a1000000-0000-4000-8000-000000000000', 'Bad draft', '[1, 2, 3]') $$,
  '23514', null, 'workflow drafts must be JSON objects'
);

reset role;
select throws_ok(
  $$ update public.employee_versions set instructions = 'changed' where id = 'a2000000-0000-4000-8000-000000000002' $$,
  '42501', null, 'employee versions are immutable'
);
select throws_ok(
  $$ update public.workflow_versions set graph = '{"nodes": [{"id": "x", "type": "delay"}], "edges": []}'
     where id = 'a5000000-0000-4000-8000-000000000002' $$,
  '42501', null, 'workflow versions are immutable'
);
select throws_ok(
  $$ insert into public.workflow_versions (organization_id, workflow_id, graph)
     values ('a1000000-0000-4000-8000-000000000000', 'a5000000-0000-4000-8000-000000000001',
       '{"nodes": [{"id": "draft", "type": "employee_task"}], "edges": [{"source": "draft", "target": "missing"}]}') $$,
  '23514', null, 'published workflow graphs cannot have edges to missing nodes'
);
select throws_ok(
  $$ insert into public.workflow_versions (organization_id, workflow_id, graph)
     values ('a1000000-0000-4000-8000-000000000000', 'a5000000-0000-4000-8000-000000000001',
       '{"nodes": [{"id": "a", "type": "teleport"}], "edges": []}') $$,
  '23514', null, 'published workflow graphs only use known node types'
);
select is(
  (select graph_sha256 from public.workflow_versions where id = 'a5000000-0000-4000-8000-000000000002'),
  (select encode(extensions.digest(graph::text, 'sha256'), 'hex') from public.workflow_versions
   where id = 'a5000000-0000-4000-8000-000000000002'),
  'workflow versions record the fingerprint of their graph'
);
select throws_ok(
  $$ insert into public.tasks (organization_id, title, source, status, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'x', 'manual', 'finished', 'k-status') $$,
  '23514', null, 'invalid task statuses are rejected'
);
select throws_ok(
  $$ insert into public.tasks (organization_id, title, source, status, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'x', 'manual', 'succeeded', 'k-done') $$,
  '23514', null, 'a finished task must record when it finished'
);
select throws_ok(
  $$ insert into public.tasks (organization_id, title, source, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'duplicate', 'workflow', 'k-orphan') $$,
  '23514', null, 'workflow tasks must belong to a workflow run'
);
select throws_ok(
  $$ insert into public.tasks (organization_id, workflow_run_id, node_id, title, source, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 'draft', 'again',
       'workflow', 'task-1') $$,
  '23505', null, 'idempotency keys prevent duplicate tasks'
);
select throws_ok(
  $$ insert into public.usage_records (organization_id, metric, quantity, cost_micros, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'model_cost', 1, 100, 'k-currency') $$,
  '23514', null, 'a cost must carry a currency'
);
select throws_ok(
  $$ insert into public.usage_records (organization_id, metric, quantity, cost_micros, currency, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'model_cost', 1, 100, 'usd', 'k-lower') $$,
  '23514', null, 'currencies must be ISO 4217 codes'
);
select throws_ok(
  $$ insert into public.usage_records (organization_id, metric, quantity, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'model_cost', 1, 'usage-1') $$,
  '23505', null, 'usage records are idempotent'
);
select throws_like(
  $$ insert into public.knowledge_chunks (organization_id, source_id, chunk_index, content, content_sha256, embedding, embedding_model)
     values ('a1000000-0000-4000-8000-000000000000', 'a3000000-0000-4000-8000-000000000001', 1, 'x', repeat('b', 64),
       '[1, 2, 3]', 'other-model') $$,
  '%1024 dimensions%',
  'embeddings must have exactly 1024 dimensions'
);

-- Task dependencies -----------------------------------------------------------------
insert into public.tasks (id, organization_id, workflow_run_id, node_id, title, source, idempotency_key)
  values ('a7000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000',
    'a6000000-0000-4000-8000-000000000001', 'approve', 'Approve reply', 'workflow', 'task-2');
select lives_ok(
  $$ insert into public.task_dependencies (organization_id, task_id, depends_on_task_id)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000002',
       'a7000000-0000-4000-8000-000000000001') $$,
  'a task can depend on another task in the same run'
);
select throws_ok(
  $$ insert into public.task_dependencies (organization_id, task_id, depends_on_task_id)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001',
       'a7000000-0000-4000-8000-000000000002') $$,
  '23514', null, 'dependency cycles are rejected'
);
select throws_ok(
  $$ insert into public.task_dependencies (organization_id, task_id, depends_on_task_id)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001',
       'a7000000-0000-4000-8000-000000000001') $$,
  '23514', null, 'a task cannot depend on itself'
);
select throws_ok(
  $$ insert into public.task_dependencies (organization_id, task_id, depends_on_task_id)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001',
       'b7000000-0000-4000-8000-000000000001') $$,
  '23514', null, 'a task cannot depend on another organization''s task'
);

-- Approvals bind to the exact proposed action ------------------------------------------
insert into public.tool_executions (id, organization_id, task_id, tool_key, risk_level, input_redacted, input_sha256,
    status, policy_decision, idempotency_key)
  values ('a8000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000',
    'a7000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external', '{"to": "vip@example.test"}',
    repeat('2', 64), 'awaiting_approval', 'require_approval', 'tool-2');

select throws_ok(
  $$ insert into public.approval_requests (organization_id, tool_execution_id, task_id, action_summary, proposed_action,
       payload_sha256, expires_at)
     values ('a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-000000000002',
       'a7000000-0000-4000-8000-000000000001', 'Send', '{}', repeat('3', 64), now() + interval '1 hour') $$,
  '23514', null, 'an approval request must carry the fingerprint of the action it approves'
);
insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, action_summary, proposed_action,
    payload_sha256, expires_at)
  values ('a9000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000',
    'a8000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000001', 'Send to VIP',
    '{"to": "vip@example.test"}', repeat('2', 64), now() + interval '1 hour');

select throws_ok(
  $$ update public.tool_executions set status = 'executing', started_at = now()
     where id = 'a8000000-0000-4000-8000-000000000002' $$,
  '42501', null, 'an action that requires approval cannot run before it is approved'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-000000000002', 'approved', repeat('3', 64)) $$,
  '40001', null, 'an approval is refused if the action changed since it was reviewed'
);
select lives_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-000000000002', 'approved', repeat('2', 64)) $$,
  'the reviewed action can be approved'
);
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-000000000002', 'rejected', repeat('2', 64)) $$,
  '55000', null, 'a decided approval cannot be decided again'
);
select throws_ok(
  $$ update public.approval_requests set status = 'pending' where id = 'a9000000-0000-4000-8000-000000000002' $$,
  '42501', null, 'clients cannot edit approval requests directly'
);

reset role;
select lives_ok(
  $$ update public.tool_executions set status = 'executing', started_at = now()
     where id = 'a8000000-0000-4000-8000-000000000002' $$,
  'the approved action can run'
);
select throws_ok(
  $$ update public.tool_executions set input_sha256 = repeat('4', 64) where id = 'a8000000-0000-4000-8000-000000000002' $$,
  '42501', null, 'the action cannot be swapped after approval'
);
select throws_ok(
  $$ update public.approval_requests set payload_sha256 = repeat('4', 64) where id = 'a9000000-0000-4000-8000-000000000002' $$,
  '42501', null, 'the approved fingerprint cannot be changed'
);

insert into public.tool_executions (id, organization_id, task_id, tool_key, risk_level, input_sha256, status,
    policy_decision, idempotency_key)
  values ('a8000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000',
    'a7000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external', repeat('5', 64), 'awaiting_approval',
    'require_approval', 'tool-3');
insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, action_summary, proposed_action,
    payload_sha256, created_at, expires_at)
  values ('a9000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000',
    'a8000000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-000000000001', 'Late', '{}', repeat('5', 64),
    now() - interval '2 days', now() - interval '1 day');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  (select (public.decide_approval('a9000000-0000-4000-8000-000000000003', 'approved', repeat('5', 64))).status),
  'expired',
  'an expired approval cannot be approved'
);
reset role;
select is(
  (select status from public.tool_executions where id = 'a8000000-0000-4000-8000-000000000003'),
  'cancelled',
  'the expired action is cancelled'
);
select throws_ok(
  $$ update public.tool_executions set status = 'executing' where id = 'a8000000-0000-4000-8000-000000000003' $$,
  '42501', null, 'an expired action can never run'
);
select throws_ok(
  $$ insert into public.tool_executions (organization_id, task_id, tool_key, risk_level, input_sha256, status,
       policy_decision, idempotency_key)
     values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001', 'gmail.send',
       'write_external', repeat('6', 64), 'executing', 'deny', 'tool-4') $$,
  '23514', null, 'a denied action is recorded as skipped and never runs'
);
select throws_ok(
  $$ insert into public.integration_actions (organization_id, integration_id, action_key, risk_level, approval_mode)
     values ('a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 'payments.transfer',
       'sensitive', 'allow') $$,
  '23514', null, 'sensitive actions can never be configured to run without approval'
);

-- Audit log ---------------------------------------------------------------------------
select isnt_empty(
  $$ select id from public.audit_logs where action = 'organization_members.insert'
       and organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'membership changes are audited automatically'
);
select isnt_empty(
  $$ select id from public.audit_logs where action = 'approval_requests.update'
       and actor_user_id = 'a0000000-0000-4000-8000-000000000003'
       and metadata -> 'status' ->> 'to' = 'approved' $$,
  'approval decisions are audited with the deciding user'
);
select is_empty(
  $$ select id from public.audit_logs where metadata::text like '%nxf1.%' or metadata::text like '%ciphertext":%' $$,
  'audit records never contain credential material'
);
select throws_ok(
  $$ update public.audit_logs set action = 'organization_members.delete' $$,
  '42501', null, 'audit records cannot be modified'
);
select throws_ok(
  $$ delete from public.audit_logs $$,
  '42501', null, 'audit records cannot be deleted'
);
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
select throws_ok(
  $$ delete from public.audit_logs $$,
  '42501', null, 'not even the service role can delete audit records directly'
);
select throws_ok(
  $$ select private.purge_audit_logs(now()) $$,
  '22023', null, 'retention purges keep at least a year of audit history'
);

select * from finish();
rollback;

-- Retention guards (migration retention_guard_strict): a finished action's
-- payload and a decided approval's proposed action change only while the
-- retention purge runs, only into the purged shape, and only once. An unset
-- purge flag means "not purging" (it used to read as NULL and skip the check).
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

-- A finished action with a payload, and a decided approval (as the database owner).
insert into public.tool_executions (id, organization_id, task_id, tool_key, risk_level, input_redacted, input_sha256,
    output_redacted, status, policy_decision, idempotency_key, started_at, finished_at)
values ('a8000000-0000-4000-8000-0000000000f5', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001',
  'hubspot.contacts.search', 'read', '{"email": "dana@example.test"}', repeat('9', 64), '{"total": 1}', 'succeeded', 'allow',
  'guard-tool-1', now() - interval '2 minutes', now() - interval '1 minute');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select public.decide_approval('a9000000-0000-4000-8000-000000000001', 'rejected', repeat('1', 64));
reset role;
set local request.jwt.claims = '{}';

select is(coalesce(current_setting('nexefiy.retention_purge', true), ''), '', 'the purge flag is not on (unset or empty)');

-- Tool executions -------------------------------------------------------------------

select throws_ok(
  $$ update public.tool_executions set input_redacted = '{"email": "forged@example.test"}', payload_purged_at = now()
     where id = 'a8000000-0000-4000-8000-0000000000f5' $$,
  '42501', null, 'with the flag unset, a finished payload cannot be rewritten by marking it purged'
);
select throws_ok(
  $$ update public.tool_executions set input_redacted = '{}', output_redacted = null, payload_purged_at = now()
     where id = 'a8000000-0000-4000-8000-0000000000f5' $$,
  '42501', null, 'with the flag unset, not even the purged shape is accepted'
);
select throws_ok(
  $$ update public.approval_requests
     set proposed_action = jsonb_build_object('purged', true, 'action', proposed_action -> 'action', 'actionTitle', proposed_action -> 'actionTitle')
     where id = 'a9000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'with the flag unset, a decided approval cannot be changed, not even into the purged shape'
);
select throws_ok(
  $$ update public.approval_requests set proposed_action = '{"to": "attacker@example.test"}'
     where id = 'a9000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'with the flag unset, a decided approval''s action cannot be rewritten'
);

select set_config('nexefiy.retention_purge', 'on', true);
select throws_ok(
  $$ update public.tool_executions set input_redacted = '{"email": "forged@example.test"}', output_redacted = null,
       payload_purged_at = now() where id = 'a8000000-0000-4000-8000-0000000000f5' $$,
  '42501', null, 'while purging, a payload can only be cleared, not replaced'
);
select throws_ok(
  $$ update public.tool_executions set input_redacted = '{}', output_redacted = null, payload_purged_at = now()
     where id = 'a8000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'while purging, an unfinished action''s payload is left alone'
);
select lives_ok(
  $$ update public.tool_executions set input_redacted = '{}', output_redacted = null, payload_purged_at = now()
     where id = 'a8000000-0000-4000-8000-0000000000f5' $$,
  'while purging, a finished payload is cleared'
);
select throws_ok(
  $$ update public.tool_executions set payload_purged_at = null where id = 'a8000000-0000-4000-8000-0000000000f5' $$,
  '42501', null, 'a purge mark cannot be cleared'
);
select throws_ok(
  $$ update public.tool_executions set input_redacted = '{"email": "back@example.test"}'
     where id = 'a8000000-0000-4000-8000-0000000000f5' $$,
  '42501', null, 'a purged payload cannot be filled in again'
);
select set_config('nexefiy.retention_purge', '', true);

-- Approval requests (the flag-unset checks ran above, before the flag was ever set) ------

select set_config('nexefiy.retention_purge', 'on', true);
select throws_ok(
  $$ update public.approval_requests set proposed_action = '{"purged": true, "to": "attacker@example.test"}'
     where id = 'a9000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'while purging, only the exact purged shape is accepted'
);
select throws_ok(
  $$ update public.approval_requests
     set proposed_action = jsonb_build_object('purged', true, 'action', proposed_action -> 'action', 'actionTitle', proposed_action -> 'actionTitle')
     where id = 'b9000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'while purging, a pending approval is left alone'
);
select lives_ok(
  $$ update public.approval_requests
     set proposed_action = jsonb_build_object('purged', true, 'action', proposed_action -> 'action', 'actionTitle', proposed_action -> 'actionTitle')
     where id = 'a9000000-0000-4000-8000-000000000001' $$,
  'while purging, a decided approval is reduced to the purged shape'
);
select throws_ok(
  $$ update public.approval_requests set proposed_action = '{"purged": true, "action": null, "actionTitle": "Changed"}'
     where id = 'a9000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'a purged approval cannot be changed again'
);
select set_config('nexefiy.retention_purge', '', true);

-- The purge itself still works ------------------------------------------------------------

insert into public.tool_executions (id, organization_id, task_id, tool_key, risk_level, input_redacted, input_sha256,
    output_redacted, status, policy_decision, idempotency_key, started_at, finished_at, created_at)
values ('a8000000-0000-4000-8000-0000000000f6', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001',
  'hubspot.contacts.search', 'read', '{"email": "old@example.test"}', repeat('8', 64), '{"total": 2}', 'succeeded', 'allow',
  'guard-tool-2', now() - interval '99 days', now() - interval '99 days', now() - interval '99 days');
insert into public.organization_governance (organization_id, payload_retention_days)
values ('a1000000-0000-4000-8000-000000000000', 30);

set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
select is(
  (select (public.purge_expired_task_data() -> 'a1000000-0000-4000-8000-000000000000' ->> 'payloads')::int),
  1, 'the retention purge clears an old finished payload'
);
reset role;
select ok(
  (select input_redacted = '{}'::jsonb and output_redacted is null and payload_purged_at is not null and input_sha256 = repeat('8', 64)
   from public.tool_executions where id = 'a8000000-0000-4000-8000-0000000000f6'),
  'the purged action keeps its fingerprint'
);
select throws_ok(
  $$ update public.tool_executions set input_redacted = '{"email": "after@example.test"}', payload_purged_at = now()
     where id = 'a8000000-0000-4000-8000-0000000000f6' $$,
  '42501', null, 'after the purge ends, payloads are protected again'
);

select * from finish();
rollback;

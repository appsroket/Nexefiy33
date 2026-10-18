-- Employee builder: configuration v2 validation, creating and editing under
-- RLS, the lifecycle (roles, transitions, typed confirmation, passing tests,
-- grants synced on activation), test runs readable but not writable by
-- clients, reviewer verdicts, per-version test status, and a skills catalog
-- that only lists tools that exist.
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

-- Helpers ----------------------------------------------------------------------

create temp table t_cfg (config jsonb not null);
insert into t_cfg values ($json${
  "profile": { "name": "Sales Ops", "department": "sales", "description": "Keeps the CRM clean." },
  "responsibilities": ["Check for duplicate contacts before creating one"],
  "skills": ["crm.records"],
  "tools": [
    { "toolKey": "hubspot.contacts.search", "integrationId": null, "approval": "allow" },
    { "toolKey": "slack.messages.post", "integrationId": null, "approval": "require_approval" }
  ],
  "knowledge": { "access": "all", "sourceIds": [], "maxPassages": 5 },
  "model": { "provider": "anthropic", "tier": "balanced", "effort": "medium", "maxOutputTokens": 8000 },
  "successCriteria": ["No duplicate contacts are created"],
  "allowedActions": ["Search the CRM"],
  "prohibitedActions": ["Send messages without approval"],
  "escalation": { "when": ["The request is unclear"], "behavior": "stop_and_report", "notes": "" },
  "limits": { "maxTurnsPerTask": 8, "maxToolCallsPerTask": 10, "maxCostUsdPerTask": 1, "maxRuntimeSeconds": 120 },
  "budget": { "monthlyUsd": 50 }
}$json$);
create temp table t_ids (label text primary key, id uuid not null);
grant all on t_cfg, t_ids to public;

-- Configuration schema v2 ------------------------------------------------------

select ok(private.employee_config_is_valid(2, (select config from t_cfg)), 'a complete v2 configuration is valid');
select ok(
  not private.employee_config_is_valid(2, (select config - 'budget' from t_cfg)),
  'a v2 configuration without a budget is invalid'
);
select ok(
  not private.employee_config_is_valid(2, (select jsonb_set(config, '{tools,1,toolKey}', '"hubspot.contacts.search"') from t_cfg)),
  'a tool can be granted only once'
);
select ok(
  not private.employee_config_is_valid(2, (select jsonb_set(config, '{knowledge,access}', '"selected"') from t_cfg)),
  '"selected" knowledge must name sources'
);
select ok(
  not private.employee_config_is_valid(2, (select jsonb_set(config, '{model,effort}', '"max"') from t_cfg)),
  'model effort is limited to low, medium and high'
);
select ok(
  not private.employee_config_is_valid(2, (select jsonb_set(config, '{limits,maxCostUsdPerTask}', '0') from t_cfg)),
  'the per-task cost limit must be positive'
);
select ok(private.employee_config_is_valid(1, '{"modelTier": "fast", "limits": {"maxTurnsPerTask": 1, "maxToolCallsPerTask": 0, "maxCostUsdPerTask": 1}}'),
  'version 1 configurations stay valid');

-- Creating and editing -----------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.create_employee('a1000000-0000-4000-8000-000000000000', 'Be helpful.', (select config from t_cfg)) $$,
  '42501', null,
  'a viewer cannot create an employee'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.create_employee('b1000000-0000-4000-8000-000000000000', 'Be helpful.', (select config from t_cfg)) $$,
  '42501', null,
  'an operator cannot create an employee in another organization'
);
select lives_ok(
  $$ insert into t_ids select 'sales', public.create_employee('a1000000-0000-4000-8000-000000000000', 'Be helpful.', (select config from t_cfg), 'First draft') $$,
  'an operator creates an employee with its first version'
);
select ok(
  (select e.lifecycle_status = 'draft' and e.name = 'Sales Ops' and e.role_category = 'sales' and v.version = 1
   from public.ai_employees as e join public.employee_versions as v on v.id = e.current_version_id
   where e.id = (select id from t_ids where label = 'sales')),
  'the new employee is a draft whose current version is version 1, with the profile copied'
);
select throws_ok(
  $$ update public.ai_employees set status = 'active' where id = (select id from t_ids where label = 'sales') $$,
  '42501', null,
  'clients cannot change an employee''s status directly'
);
select throws_ok(
  $$ update public.ai_employees set current_version_id = 'a2000000-0000-4000-8000-000000000002' where id = (select id from t_ids where label = 'sales') $$,
  '42501', null,
  'clients cannot move version pointers directly'
);
select throws_ok(
  $$ select public.save_employee_version((select id from t_ids where label = 'sales'), 'a2000000-0000-4000-8000-000000000002',
       'Be helpful.', (select config from t_cfg)) $$,
  '40001', null,
  'saving from an outdated version is refused'
);
select lives_ok(
  $$ select public.save_employee_version(
       (select id from t_ids where label = 'sales'),
       (select current_version_id from public.ai_employees where id = (select id from t_ids where label = 'sales')),
       'Be helpful and brief.',
       (select jsonb_set(config, '{profile,name}', '"Sales Operations"') from t_cfg),
       'Renamed') $$,
  'saving from the current version works'
);
select ok(
  (select e.name = 'Sales Operations' and v.version = 2 and v.instructions = 'Be helpful and brief.'
   from public.ai_employees as e join public.employee_versions as v on v.id = e.current_version_id
   where e.id = (select id from t_ids where label = 'sales')),
  'a saved version becomes current and its profile is copied to the employee'
);
select throws_ok(
  $$ select public.save_employee_version('b2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002',
       'Hijack.', (select config from t_cfg)) $$,
  'P0002', null,
  'an operator cannot edit another organization''s employee'
);
select throws_ok(
  $$ insert into public.employee_test_runs (organization_id, employee_id, version_id, input, result, finished_at)
     values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'sales'),
       (select current_version_id from public.ai_employees where id = (select id from t_ids where label = 'sales')),
       'hello', 'passed', now()) $$,
  '42501', null,
  'clients cannot record test runs'
);

-- Lifecycle -----------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.change_employee_status((select id from t_ids where label = 'sales'), 'start_testing') $$,
  'P0002', null,
  'a viewer cannot change an employee''s status'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  (select public.change_employee_status((select id from t_ids where label = 'sales'), 'start_testing') ->> 'status'),
  'testing',
  'an operator moves a saved draft to testing'
);
select throws_ok(
  $$ select public.change_employee_status((select id from t_ids where label = 'sales'), 'start_testing') $$,
  '55000', null,
  'an employee already in testing cannot start testing again'
);
select throws_ok(
  $$ select public.change_employee_status((select id from t_ids where label = 'sales'), 'activate',
       (select current_version_id from public.ai_employees where id = (select id from t_ids where label = 'sales')), 'Sales Operations') $$,
  'P0002', null,
  'an operator cannot activate an employee'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select throws_ok(
  $$ select public.change_employee_status((select id from t_ids where label = 'sales'), 'activate',
       (select current_version_id from public.ai_employees where id = (select id from t_ids where label = 'sales')), 'Sales Operations') $$,
  '23514', null,
  'an untested version cannot be activated'
);
reset role;

-- Test cases and runs (runs are recorded by the server, here as the owner).
insert into t_ids
select 'version2', current_version_id from public.ai_employees where id = (select id from t_ids where label = 'sales');
insert into t_ids
select 'version1', v.id from public.employee_versions as v where v.employee_id = (select id from t_ids where label = 'sales') and v.version = 1;

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select lives_ok(
  $$ with created as (
       insert into public.employee_test_cases (organization_id, employee_id, name, input, expectations)
       values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'sales'), 'Duplicate check',
         'A lead from jane@example.test came in.', '{"mustUseTools": ["hubspot.contacts.search"]}')
       returning id
     )
     insert into t_ids select 'case', id from created $$,
  'an operator saves a test case'
);
select throws_ok(
  $$ insert into public.employee_test_cases (organization_id, employee_id, name, input)
     values ('b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001', 'Sneaky', 'hi') $$,
  '42501', null,
  'an operator cannot add test cases to another organization''s employee'
);
select throws_ok(
  $$ insert into public.employee_test_cases (organization_id, employee_id, name, input, expectations)
     values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'sales'), 'Bad', 'hi', '{"surprise": true}') $$,
  '23514', null,
  'test case expectations follow their schema'
);
reset role;

select is(private.employee_version_test_status((select id from t_ids where label = 'version2')), 'untested',
  'a version without runs is untested');

insert into public.employee_test_runs (id, organization_id, employee_id, version_id, input, result, finished_at)
values ('a2000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'sales'),
  (select id from t_ids where label = 'version2'), 'Try a free-form request', 'needs_review', now());
select is(private.employee_version_test_status((select id from t_ids where label = 'version2')), 'incomplete',
  'a saved test case that has not run on this version leaves it incomplete');

-- Inside one transaction now() doesn't move, so run times are set explicitly.
insert into public.employee_test_runs (organization_id, employee_id, version_id, test_case_id, input, result, error,
    started_at, finished_at, created_at)
values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'sales'), (select id from t_ids where label = 'version2'),
  (select id from t_ids where label = 'case'), 'A lead from jane@example.test came in.', 'failed', null,
  now() - interval '2 minutes', now() - interval '1 minute', now() - interval '2 minutes');
select is(private.employee_version_test_status((select id from t_ids where label = 'version2')), 'failed',
  'a failed latest run of a test case fails the version');

insert into public.employee_test_runs (organization_id, employee_id, version_id, test_case_id, input, result, finished_at)
values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'sales'), (select id from t_ids where label = 'version2'),
  (select id from t_ids where label = 'case'), 'A lead from jane@example.test came in.', 'passed', now());
select is(private.employee_version_test_status((select id from t_ids where label = 'version2')), 'needs_review',
  'a free-form run waiting for review keeps the version in review');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.review_employee_test_run('a2000000-0000-4000-8000-0000000000f1', 'passed') $$,
  'P0002', null,
  'a viewer cannot review a test run'
);
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.review_employee_test_run('a2000000-0000-4000-8000-0000000000f1', 'passed') $$,
  'P0002', null,
  'another organization cannot review a test run'
);
select is_empty(
  $$ select id from public.employee_test_runs where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'another organization cannot read test runs'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is(
  (select count(*)::int from public.employee_test_runs where employee_id = (select id from t_ids where label = 'sales')),
  3,
  'members read their organization''s test runs'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.review_employee_test_run('a2000000-0000-4000-8000-0000000000f1', 'passed', 'Looks right'), 'passed',
  'an operator passes a run that was waiting for review');
select throws_ok(
  $$ select public.review_employee_test_run('a2000000-0000-4000-8000-0000000000f1', 'passed') $$,
  '55000', null,
  'a passed run cannot be passed again'
);
select is(
  (select test_status from public.employee_test_summary((select id from t_ids where label = 'sales'))
   where version_id = (select id from t_ids where label = 'version2')),
  'passed',
  'the summary shows the version as passed once every test case and review passed'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select throws_ok(
  $$ select public.change_employee_status((select id from t_ids where label = 'sales'), 'activate',
       (select id from t_ids where label = 'version2'), 'Someone else') $$,
  '22023', null,
  'activation needs the employee''s name typed to confirm'
);
select throws_ok(
  $$ select public.change_employee_status((select id from t_ids where label = 'sales'), 'activate',
       (select id from t_ids where label = 'version1'), 'Sales Operations') $$,
  '40001', null,
  'only the latest saved version can be activated'
);
select is(
  (select public.change_employee_status((select id from t_ids where label = 'sales'), 'activate',
     (select id from t_ids where label = 'version2'), ' sales operations ') ->> 'status'),
  'active',
  'an admin activates a tested version after confirming its name'
);
reset role;

select ok(
  (select active_version_id = (select id from t_ids where label = 'version2') and activated_by = 'a0000000-0000-4000-8000-000000000002'
     and testing_started_at is null
   from public.ai_employees where id = (select id from t_ids where label = 'sales')),
  'activation records the active version and who activated it'
);
select is(
  (select array_agg(tool_key || ':' || decision order by tool_key) from public.employee_tool_permissions
   where employee_id = (select id from t_ids where label = 'sales')),
  array['hubspot.contacts.search:allow', 'slack.messages.post:require_approval'],
  'activation grants exactly the version''s tools with their approval rules'
);
select is(
  (select count(*)::int from public.employee_skills as es join public.skills as s on s.id = es.skill_id
   where es.employee_id = (select id from t_ids where label = 'sales') and s.key = 'crm.records'),
  1,
  'activation links the version''s skills'
);
select ok(
  exists (select 1 from public.audit_logs where action = 'employee.activated' and target_id = (select id::text from t_ids where label = 'sales')
          and metadata ->> 'version' = '2'),
  'activation is audited with the version number'
);

-- Editing an active employee does not change what runs.
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select lives_ok(
  $$ select public.save_employee_version((select id from t_ids where label = 'sales'), (select id from t_ids where label = 'version2'),
       'Be helpful, brief and careful.', (select jsonb_set(config, '{profile,name}', '"Sales Operations"') from t_cfg), 'Tweak') $$,
  'an operator saves a new version of an active employee'
);
select ok(
  (select lifecycle_status = 'active' and active_version_id = (select id from t_ids where label = 'version2')
     and current_version_id <> active_version_id
   from public.ai_employees where id = (select id from t_ids where label = 'sales')),
  'the active version keeps running until the new one is activated'
);
select is(
  (select public.change_employee_status((select id from t_ids where label = 'sales'), 'pause') ->> 'status'),
  'paused',
  'an operator pauses an active employee'
);
select throws_ok(
  $$ select public.change_employee_status((select id from t_ids where label = 'sales'), 'resume') $$,
  'P0002', null,
  'an operator cannot resume a paused employee'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  (select public.change_employee_status((select id from t_ids where label = 'sales'), 'resume') ->> 'status'),
  'active',
  'an admin resumes it'
);
select is(
  (select public.change_employee_status((select id from t_ids where label = 'sales'), 'archive') ->> 'status'),
  'archived',
  'an admin archives it'
);
select throws_ok(
  $$ select public.save_employee_version((select id from t_ids where label = 'sales'),
       (select current_version_id from public.ai_employees where id = (select id from t_ids where label = 'sales')),
       'Edit while archived.', (select jsonb_set(config, '{profile,name}', '"Sales Operations"') from t_cfg)) $$,
  '55000', null,
  'an archived employee cannot be edited'
);
select is(
  (select public.change_employee_status((select id from t_ids where label = 'sales'), 'restore') ->> 'status'),
  'draft',
  'an admin restores it as a draft'
);
select ok(
  (select active_version_id is null from public.ai_employees where id = (select id from t_ids where label = 'sales')),
  'a restored employee has no active version until it is activated again'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
delete from public.ai_employees where id = (select id from t_ids where label = 'sales');
select ok(
  exists (select 1 from public.ai_employees where id = (select id from t_ids where label = 'sales')),
  'an employee that was once activated cannot be deleted (only archived)'
);
select lives_ok(
  $$ insert into t_ids select 'scratch', public.create_employee('a1000000-0000-4000-8000-000000000000', 'Scratch.',
       (select jsonb_set(config, '{profile,name}', '"Scratch"') from t_cfg)) $$,
  'an operator creates a throwaway draft'
);
delete from public.ai_employees where id = (select id from t_ids where label = 'scratch');
select ok(
  not exists (select 1 from public.ai_employees where id = (select id from t_ids where label = 'scratch')),
  'a never-activated draft can be deleted'
);
reset role;

select throws_ok(
  $$ update public.ai_employees set testing_started_at = now() where id = 'a2000000-0000-4000-8000-000000000001' $$,
  '23514', null,
  'only a draft can be in testing'
);

-- Skills catalog -------------------------------------------------------------------

select is_empty(
  $$ select s.key from public.skills as s, unnest(s.tool_keys) as t(tool_key)
     where s.organization_id is null and s.status = 'active'
       and t.tool_key not in ('knowledge.search', 'hubspot.contacts.search', 'hubspot.contacts.upsert', 'hubspot.notes.create',
         'slack.channels.list', 'slack.messages.post') $$,
  'active built-in skills list only tools that exist'
);

select * from finish();
rollback;

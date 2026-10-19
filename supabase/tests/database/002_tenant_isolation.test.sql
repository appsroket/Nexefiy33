-- Tenant isolation: anonymous visitors, outsiders, and members of one
-- organization cannot read, change, or reference another organization's data.
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

-- Anonymous visitors ---------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';

select throws_ok('select count(*) from public.organizations', '42501', null, 'anon cannot read organizations');
select throws_ok('select count(*) from public.ai_employees', '42501', null, 'anon cannot read employees');
select throws_ok('select count(*) from public.tasks', '42501', null, 'anon cannot read tasks');
select throws_ok('select count(*) from public.audit_logs', '42501', null, 'anon cannot read audit logs');
select throws_ok('select count(*) from public.integration_secrets', '42501', null, 'anon cannot read credentials');
select throws_ok(
  $$ select public.create_organization('Anon Org', 'anon-org') $$, '42501', null,
  'anon cannot create organizations'
);
select is((select count(*)::int from public.plans), 4, 'anon can read the public plan catalog');

-- A signed-in user with no memberships ----------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select is_empty('select id from public.organizations', 'an outsider sees no organizations');
select is_empty('select id from public.ai_employees', 'an outsider sees no employees');
select is_empty('select id from public.audit_logs', 'an outsider sees no audit logs');
select is_empty(
  $$ select id from public.profiles where id <> 'c0000000-0000-4000-8000-000000000001' $$,
  'an outsider sees no other profiles'
);
select is((select count(*)::int from public.skills), 5, 'an outsider sees only the built-in skills');
select throws_ok(
  $$ insert into public.ai_employees (organization_id, name, role_category)
     values ('a1000000-0000-4000-8000-000000000000', 'Intruder', 'custom') $$,
  '42501', null,
  'an outsider cannot create employees in an organization they do not belong to'
);
select lives_ok(
  $$ select public.create_organization('Outsider Co', 'outsider-co') $$,
  'any signed-in user can create an organization'
);
select is(
  (select m.role from public.organization_members m join public.organizations o on o.id = m.organization_id
   where o.slug = 'outsider-co' and m.user_id = 'c0000000-0000-4000-8000-000000000001'),
  'owner',
  'the creator becomes the owner'
);
select is(
  (select count(*)::int from public.organization_policies p join public.organizations o on o.id = p.organization_id
   where o.slug = 'outsider-co'),
  1,
  'a new organization starts with the default approval policy'
);

-- Owner of organization A against organization B --------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select is(
  (select array_agg(id) from public.organizations),
  array['a1000000-0000-4000-8000-000000000000'::uuid],
  'owner A sees only organization A'
);

select is_empty(
  $$ select t, n from (values
       ('company_settings', (select count(*) from public.company_settings)),
       ('organization_members', (select count(*) from public.organization_members)),
       ('ai_employees', (select count(*) from public.ai_employees)),
       ('employee_versions', (select count(*) from public.employee_versions)),
       ('employee_skills', (select count(*) from public.employee_skills)),
       ('employee_tool_permissions', (select count(*) from public.employee_tool_permissions)),
       ('knowledge_sources', (select count(*) from public.knowledge_sources)),
       ('knowledge_chunks', (select count(*) from public.knowledge_chunks)),
       ('integrations', (select count(*) from public.integrations)),
       ('integration_actions', (select count(*) from public.integration_actions)),
       ('workflow_definitions', (select count(*) from public.workflow_definitions)),
       ('workflow_versions', (select count(*) from public.workflow_versions)),
       ('workflow_triggers', (select count(*) from public.workflow_triggers)),
       ('workflow_runs', (select count(*) from public.workflow_runs)),
       ('tasks', (select count(*) from public.tasks)),
       ('task_attempts', (select count(*) from public.task_attempts)),
       ('tool_executions', (select count(*) from public.tool_executions)),
       ('execution_events', (select count(*) from public.execution_events)),
       ('organization_policies', (select count(*) from public.organization_policies)),
       ('approval_requests', (select count(*) from public.approval_requests)),
       ('audit_logs', (select count(*) from public.audit_logs)),
       ('subscriptions', (select count(*) from public.subscriptions)),
       ('usage_records', (select count(*) from public.usage_records)),
       ('outcome_records', (select count(*) from public.outcome_records))
     ) as v (t, n) where n = 0 $$,
  'owner A can read their own rows in every tenant table (the isolation checks below are meaningful)'
);

select is(
  (select count(*)::int from (
    select organization_id from public.company_settings
    union all select organization_id from public.organization_members
    union all select organization_id from public.organization_invitations
    union all select organization_id from public.ai_employees
    union all select organization_id from public.employee_versions
    union all select organization_id from public.employee_skills
    union all select organization_id from public.employee_tool_permissions
    union all select organization_id from public.skills where organization_id is not null
    union all select organization_id from public.knowledge_sources
    union all select organization_id from public.knowledge_chunks
    union all select organization_id from public.integrations
    union all select organization_id from public.integration_actions
    union all select organization_id from public.workflow_definitions
    union all select organization_id from public.workflow_versions
    union all select organization_id from public.workflow_triggers
    union all select organization_id from public.workflow_runs
    union all select organization_id from public.tasks
    union all select organization_id from public.task_dependencies
    union all select organization_id from public.task_attempts
    union all select organization_id from public.tool_executions
    union all select organization_id from public.execution_events
    union all select organization_id from public.organization_policies
    union all select organization_id from public.approval_requests
    union all select organization_id from public.audit_logs
    union all select organization_id from public.subscriptions
    union all select organization_id from public.usage_records
    union all select organization_id from public.outcome_records
  ) as rows where organization_id = 'b1000000-0000-4000-8000-000000000000'),
  0,
  'owner A cannot read a single row of organization B in any table'
);

select is_empty(
  $$ select id from public.profiles where id = 'b0000000-0000-4000-8000-000000000001' $$,
  'owner A cannot read the profile of a user who only belongs to organization B'
);

select is_empty(
  $$ update public.organizations set name = 'Hacked' where id = 'b1000000-0000-4000-8000-000000000000' returning id $$,
  'owner A cannot rename organization B'
);
select is_empty(
  $$ update public.company_settings set description = 'Hacked'
     where organization_id = 'b1000000-0000-4000-8000-000000000000' returning organization_id $$,
  'owner A cannot change organization B settings'
);
select is_empty(
  $$ update public.ai_employees set avatar_url = null where id = 'b2000000-0000-4000-8000-000000000001' returning id $$,
  'owner A cannot change organization B employees'
);
select is_empty(
  $$ delete from public.ai_employees where id = 'b2000000-0000-4000-8000-000000000001' returning id $$,
  'owner A cannot delete organization B employees'
);
select is_empty(
  $$ delete from public.integrations where id = 'b4000000-0000-4000-8000-000000000001' returning id $$,
  'owner A cannot delete organization B integrations'
);
select is_empty(
  $$ update public.organization_members set role = 'viewer'
     where organization_id = 'b1000000-0000-4000-8000-000000000000' returning user_id $$,
  'owner A cannot change organization B memberships'
);
select is_empty(
  $$ delete from public.organization_members
     where organization_id = 'b1000000-0000-4000-8000-000000000000' returning user_id $$,
  'owner A cannot remove organization B members'
);
select is_empty(
  $$ delete from public.organizations where id = 'b1000000-0000-4000-8000-000000000000' returning id $$,
  'owner A cannot delete organization B'
);

select throws_ok(
  $$ insert into public.ai_employees (organization_id, name, role_category)
     values ('b1000000-0000-4000-8000-000000000000', 'Planted', 'custom') $$,
  '42501', null,
  'owner A cannot create rows in organization B'
);
select throws_ok(
  $$ insert into public.employee_versions (organization_id, employee_id, instructions, config)
     values ('a1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001', 'x',
       '{"modelTier": "fast", "limits": {"maxTurnsPerTask": 1, "maxToolCallsPerTask": 0, "maxCostUsdPerTask": 1}}') $$,
  '23503', null,
  'a row claiming organization A cannot reference organization B''s employee (composite foreign key)'
);
select throws_ok(
  $$ insert into public.employee_tool_permissions (organization_id, employee_id, tool_key, integration_id)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'gmail.read',
       'b4000000-0000-4000-8000-000000000001') $$,
  '23503', null,
  'an employee cannot be granted a tool through another organization''s integration'
);
select throws_ok(
  $$ insert into public.employee_skills (organization_id, employee_id, skill_id)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
       'bb000000-0000-4000-8000-000000000001') $$,
  '23503', null,
  'an employee cannot use another organization''s custom skill'
);
select throws_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type, integration_id, created_by)
     values ('a1000000-0000-4000-8000-000000000000', 'Stolen', 'integration', 'b4000000-0000-4000-8000-000000000001',
       'a0000000-0000-4000-8000-000000000001') $$,
  '42501', null,
  'clients cannot create integration-backed knowledge sources'
);
-- The composite foreign key holds even for server code.
reset role;
select throws_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type, integration_id)
     values ('a1000000-0000-4000-8000-000000000000', 'Stolen', 'integration', 'b4000000-0000-4000-8000-000000000001') $$,
  '23503', null,
  'a knowledge source cannot read through another organization''s integration'
);
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select is_empty(
  $$ select chunk_id from public.match_knowledge_chunks('b1000000-0000-4000-8000-000000000000',
       array_fill(0.01::real, array[1024])::extensions.vector) $$,
  'knowledge search returns nothing for another organization'
);
select isnt_empty(
  $$ select chunk_id from public.match_knowledge_chunks('a1000000-0000-4000-8000-000000000000',
       array_fill(0.01::real, array[1024])::extensions.vector) $$,
  'knowledge search returns the caller''s own chunks'
);
select throws_ok(
  $$ select public.decide_approval('b9000000-0000-4000-8000-000000000001', 'approved', repeat('1', 64)) $$,
  'P0002', null,
  'owner A cannot decide organization B''s approvals'
);
select throws_ok(
  $$ select * from public.create_invitation('b1000000-0000-4000-8000-000000000000', 'spy@example.test', 'viewer') $$,
  '42501', null,
  'owner A cannot invite people into organization B'
);

-- Organization B is untouched -----------------------------------------------------
reset role;
select is(
  (select name from public.organizations where id = 'b1000000-0000-4000-8000-000000000000'),
  'Org B',
  'organization B still has its original name'
);
select is(
  (select count(*)::int from public.ai_employees where organization_id = 'b1000000-0000-4000-8000-000000000000'),
  1,
  'organization B still has its employee'
);
select is(
  (select status from public.approval_requests where id = 'b9000000-0000-4000-8000-000000000001'),
  'pending',
  'organization B''s approval is still pending'
);

select * from finish();
rollback;

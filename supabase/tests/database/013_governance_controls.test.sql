-- Governance controls, called directly as each role (as PostgREST would):
-- policy versions and who authorized them, approval integrity (only a
-- signed-in member with the required role approves, never the service role an
-- employee runs as; separate approvers; payload binding; expiry), the
-- workspace and employee emergency stops, revocation of tools and
-- connections, tool allowlists, human handoff, evidence retention, and the
-- audit trail each of these leaves.
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

-- A standalone employee task waiting on an approval, a queued one, and a
-- running one whose worker died (all in organization A).
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    created_by, started_at)
values
  ('a7000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Email the customer', 'manual', 'waiting_approval', 'gov-task-1',
    'a0000000-0000-4000-8000-000000000003', now()),
  ('a7000000-0000-4000-8000-0000000000d2', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Queued work', 'manual', 'queued', 'gov-task-2', null, null),
  ('a7000000-0000-4000-8000-0000000000d3', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Running work', 'manual', 'queued', 'gov-task-3', null, now());
insert into public.task_attempts (organization_id, task_id, attempt_number)
  values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d3', 1);
update public.tasks set status = 'running', lease_expires_at = now() - interval '1 minute', attempt_count = 1
where id = 'a7000000-0000-4000-8000-0000000000d3';

-- The action the first task waits on, requested on behalf of the operator who assigned it.
insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    input_redacted, input_sha256, status, policy_decision, idempotency_key, requested_by, action_category, risk_tier)
values ('a8000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d1',
  'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
  '{"to": "customer@example.test"}', repeat('d', 64), 'awaiting_approval', 'require_approval', 'gov-tool-1',
  'a0000000-0000-4000-8000-000000000003', 'external_message', 'high');
insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, employee_id, action_summary,
    proposed_action, payload_sha256, required_role, separate_approver, action_category, risk_tier, binding, expires_at)
values ('a9000000-0000-4000-8000-0000000000d1', 'a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-0000000000d1',
  'a7000000-0000-4000-8000-0000000000d1', 'a2000000-0000-4000-8000-000000000001', 'Email the customer',
  '{"action": "gmail.send", "input": {"to": "customer@example.test"}}', repeat('d', 64), 'operator', true,
  'external_message', 'high', '{"connectionAccountId": "acct-a"}', now() + interval '1 day');

-- ===========================================================================
-- Policy versions and authorization
-- ===========================================================================

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select throws_ok(
  $$ insert into public.organization_policies (organization_id, name, policy_schema_version, policy)
     values ('a1000000-0000-4000-8000-000000000000', 'Operator policy', 2, '{"rules": []}') $$,
  '42501', null, 'an operator cannot create a policy'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select throws_ok(
  $$ insert into public.organization_policies (organization_id, name, policy_schema_version, policy)
     values ('a1000000-0000-4000-8000-000000000000', 'Bad', 2, '{"rules": [{"effect": "allow", "categories": ["teleport"]}]}') $$,
  '23514', null, 'a version 2 document with an unknown category is rejected'
);
select throws_ok(
  $$ insert into public.organization_policies (organization_id, name, policy_schema_version, policy)
     values ('a1000000-0000-4000-8000-000000000000', 'Bad limits', 2, '{"rules": [], "limits": {"maxTaskRuntimeSeconds": 5}}') $$,
  '23514', null, 'limits outside their bounds are rejected'
);
select throws_ok(
  $$ insert into public.organization_policies (organization_id, name, policy_schema_version, policy, authorized_role)
     values ('a1000000-0000-4000-8000-000000000000', 'Forged', 2, '{"rules": []}', 'owner') $$,
  '42501', null, 'nobody writes the authorizing role directly'
);

with inserted as (
  insert into public.organization_policies (organization_id, name, policy_schema_version, policy)
  values ('a1000000-0000-4000-8000-000000000000', 'CRM updates', 2,
    '{"rules": [{"id": "crm", "effect": "allow", "toolKeys": ["hubspot.contacts.upsert"], "actors": ["employee"]}],
      "approvals": {"expiresInHours": 24}, "limits": {"maxCostUsdPerTask": 2}}')
  returning id
)
insert into t_ids select 'crm_policy', id from inserted;

select ok(
  (select authorized_by = 'a0000000-0000-4000-8000-000000000002' and authorized_role = 'admin' and revision = 1
   from public.organization_policies where id = (select id from t_ids where label = 'crm_policy')),
  'a policy records who authorized it and with which role'
);
select ok(
  (select change = 'created' and revision = 1 and authorized_role = 'admin' and changed_by = 'a0000000-0000-4000-8000-000000000002'
   from public.organization_policy_versions where policy_id = (select id from t_ids where label = 'crm_policy')),
  'creating a policy records its first version'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
update public.organization_policies
set policy = '{"rules": [{"id": "crm", "effect": "allow", "toolKeys": ["hubspot.contacts.upsert"]}]}'
where id = (select id from t_ids where label = 'crm_policy');

select ok(
  (select revision = 2 and authorized_role = 'owner' and authorized_by = 'a0000000-0000-4000-8000-000000000001'
   from public.organization_policies where id = (select id from t_ids where label = 'crm_policy')),
  'changing the document makes a new revision authorized by the person who changed it'
);
update public.organization_policies set enabled = false where id = (select id from t_ids where label = 'crm_policy');
update public.organization_policies set description = 'Only a description' where id = (select id from t_ids where label = 'crm_policy');
select is(
  (select array_agg(revision order by revision) from public.organization_policy_versions
   where policy_id = (select id from t_ids where label = 'crm_policy')),
  array[1, 2, 3], 'turning a policy off is a revision too; a description edit is not'
);
select is(
  (select policy -> 'rules' -> 0 ->> 'id' from public.organization_policy_versions
   where policy_id = (select id from t_ids where label = 'crm_policy') and revision = 1),
  'crm', 'older versions keep the document as it was'
);
select throws_ok(
  $$ update public.organization_policy_versions set enabled = true $$,
  '42501', null, 'members cannot change policy versions'
);

reset role;
select throws_ok(
  $$ update public.organization_policy_versions set enabled = true where policy_id = (select id from t_ids where label = 'crm_policy') $$,
  null, null, 'policy versions are immutable even for the database owner'
);
set local request.jwt.claims = '{}';
update public.organization_policies set enabled = true where id = (select id from t_ids where label = 'crm_policy');
select ok(
  (select authorized_role is null and authorized_by is null from public.organization_policies where id = (select id from t_ids where label = 'crm_policy')),
  'a change made without a signed-in member authorizes nothing'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
delete from public.organization_policies where id = (select id from t_ids where label = 'crm_policy');
select ok(
  (select count(*) = 1 from public.organization_policy_versions
   where policy_id = (select id from t_ids where label = 'crm_policy') and change = 'deleted'),
  'deleting a policy keeps its history'
);

set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty(
  $$ select id from public.organization_policy_versions where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'another organization sees none of these versions'
);

-- ===========================================================================
-- Approval integrity
-- ===========================================================================

reset role;
set local request.jwt.claims = '{}';
select throws_ok(
  $$ update public.approval_requests set status = 'approved', decided_at = now() where id = 'a9000000-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'without a signed-in member nothing can approve, not even the database owner'
);

set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
select throws_ok(
  $$ update public.approval_requests set status = 'approved', decided_at = now() where id = 'a9000000-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'the service role an employee runs as cannot approve'
);
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-0000000000d1', 'approved', repeat('d', 64)) $$,
  '42501', null, 'the service role cannot approve through decide_approval either'
);
select throws_ok(
  $$ update public.approval_requests set binding = '{}' where id = 'a9000000-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'what an approval is bound to cannot change'
);
select throws_ok(
  $$ update public.approval_requests set separate_approver = false where id = 'a9000000-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'the separate-approver requirement cannot be removed'
);
select throws_ok(
  $$ update public.tool_executions set status = 'executing' where id = 'a8000000-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'an action that needs approval cannot start without one'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ update public.approval_requests set status = 'approved' where id = 'a9000000-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'members cannot write approvals directly'
);
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-0000000000d1', 'approved', repeat('d', 64)) $$,
  '42501', 'you requested this action, so someone else must approve it',
  'the person who assigned the task cannot approve its action when a separate approver is required'
);
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-0000000000d1', 'approved', repeat('e', 64)) $$,
  '40001', null, 'an approval for a different payload is refused'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-0000000000d1', 'approved', repeat('d', 64)) $$,
  'P0002', null, 'a viewer cannot approve'
);

set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-0000000000d1', 'approved', repeat('d', 64)) $$,
  'P0002', null, 'another organization''s owner cannot approve'
);

-- An approval that has expired can only expire.
reset role;
set local request.jwt.claims = '{}';
insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    input_sha256, status, policy_decision, idempotency_key)
values ('a8000000-0000-4000-8000-0000000000d2', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d1',
  'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
  repeat('f', 64), 'awaiting_approval', 'require_approval', 'gov-tool-2');
insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, action_summary, proposed_action,
    payload_sha256, created_at, expires_at)
values ('a9000000-0000-4000-8000-0000000000d2', 'a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-0000000000d2',
  'a7000000-0000-4000-8000-0000000000d1', 'Old request', '{"action": "gmail.send"}', repeat('f', 64),
  now() - interval '2 days', now() - interval '1 day');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  (select status from public.decide_approval('a9000000-0000-4000-8000-0000000000d2', 'approved', repeat('f', 64))),
  'expired', 'approving after expiry records the expiry instead'
);
select is(
  (select status from public.tool_executions where id = 'a8000000-0000-4000-8000-0000000000d2'),
  'cancelled', 'the expired action is cancelled'
);
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-0000000000d2', 'approved', repeat('f', 64)) $$,
  '55000', null, 'an expired approval cannot be decided again'
);

-- ===========================================================================
-- Tool allowlists
-- ===========================================================================

insert into public.organization_policies (organization_id, name, policy_schema_version, policy)
values ('a1000000-0000-4000-8000-000000000000', 'Allowed tools', 2, '{"rules": [], "tools": {"allowlist": ["hubspot.*", "knowledge.search"]}}');

select throws_ok(
  $$ insert into public.employee_tool_permissions (organization_id, employee_id, tool_key, integration_id)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'slack.messages.post', null) $$,
  '42501', null, 'a tool outside the allowlist cannot be granted'
);
select lives_ok(
  $$ insert into public.employee_tool_permissions (organization_id, employee_id, tool_key, integration_id)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'knowledge.search', null) $$,
  'a tool on the allowlist can be granted'
);
reset role;
select lives_ok(
  $$ insert into public.employee_tool_permissions (organization_id, employee_id, tool_key, integration_id)
     values ('b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001', 'slack.messages.post', null) $$,
  'another organization''s allowlist doesn''t apply'
);
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';

-- ===========================================================================
-- Revocation
-- ===========================================================================

-- Re-granting in the same transaction (activation) cancels nothing.
delete from public.employee_tool_permissions
where employee_id = 'a2000000-0000-4000-8000-000000000001' and tool_key = 'knowledge.search';
insert into public.employee_tool_permissions (organization_id, employee_id, tool_key, integration_id)
values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'knowledge.search', null);
set constraints all immediate;
set constraints all deferred;
select is(
  (select status from public.approval_requests where id = 'a9000000-0000-4000-8000-0000000000d1'),
  'pending', 'removing and re-adding a grant leaves other actions alone'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.revoke_employee_tool('a2000000-0000-4000-8000-000000000001', 'gmail.send', 'a4000000-0000-4000-8000-000000000001') $$,
  'P0002', null, 'an operator cannot revoke an employee''s tool'
);
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.revoke_employee_tool('a2000000-0000-4000-8000-000000000001', 'gmail.send', 'a4000000-0000-4000-8000-000000000001') $$,
  'P0002', null, 'another organization''s owner cannot revoke it'
);

-- Revoking cancels the waiting actions when the change commits (forced here).
savepoint before_revoke;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  public.revoke_employee_tool('a2000000-0000-4000-8000-000000000001', 'gmail.send', 'a4000000-0000-4000-8000-000000000001'),
  1, 'an admin revokes the tool'
);
set constraints all immediate;
select ok(
  (select a.status = 'cancelled' and e.status = 'cancelled' and e.error ->> 'code' = 'permission_revoked'
   from public.approval_requests as a join public.tool_executions as e on e.id = a.tool_execution_id
   where a.id = 'a9000000-0000-4000-8000-0000000000d1'),
  'the employee''s waiting action on the revoked tool is cancelled with its approval'
);
select ok(
  (select a.status = 'cancelled' from public.approval_requests as a where a.id = 'a9000000-0000-4000-8000-000000000001'),
  'every waiting action on that tool is cancelled'
);
select ok(
  exists (select 1 from public.audit_logs where action = 'employee.tool_revoked' and actor_user_id = 'a0000000-0000-4000-8000-000000000002'),
  'the revocation is audited with the admin who did it'
);
select ok(
  exists (select 1 from public.audit_logs where action = 'employee.tool_actions_cancelled'
    and target_id = 'a2000000-0000-4000-8000-000000000001' and (metadata ->> 'cancelled_actions')::int = 2),
  'the cancelled actions are audited'
);
rollback to savepoint before_revoke;
set constraints all deferred;

-- The same through a direct API call: an admin deleting the grant row.
savepoint before_direct_delete;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
delete from public.employee_tool_permissions
where employee_id = 'a2000000-0000-4000-8000-000000000001' and tool_key = 'gmail.send';
set constraints all immediate;
select is(
  (select status from public.approval_requests where id = 'a9000000-0000-4000-8000-0000000000d1'),
  'cancelled', 'deleting the grant directly cancels the waiting action too'
);
rollback to savepoint before_direct_delete;
set constraints all deferred;

-- Narrowing the grant to "deny" through the API does the same.
savepoint before_deny;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
update public.employee_tool_permissions set decision = 'deny'
where employee_id = 'a2000000-0000-4000-8000-000000000001' and tool_key = 'gmail.send';
set constraints all immediate;
select is(
  (select status from public.approval_requests where id = 'a9000000-0000-4000-8000-0000000000d1'),
  'cancelled', 'changing the grant to deny cancels the waiting action'
);
rollback to savepoint before_deny;
set constraints all deferred;

-- Disconnecting a connection cancels what waits on it, whichever code path did it.
savepoint before_disconnect;
reset role;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
update public.integrations set status = 'revoked', revoked_at = now() where id = 'a4000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.approval_requests as a join public.tool_executions as e on e.id = a.tool_execution_id
   where e.integration_id = 'a4000000-0000-4000-8000-000000000001' and a.status = 'pending'),
  0, 'no approval is left pending on a disconnected connection'
);
select ok(
  exists (select 1 from public.audit_logs where action = 'integration.revoked' and target_id = 'a4000000-0000-4000-8000-000000000001'
    and (metadata ->> 'cancelled_actions')::int = 2),
  'the disconnection is audited with the actions it cancelled'
);
select is(
  (select status from public.approval_requests where id = 'b9000000-0000-4000-8000-000000000001'),
  'pending', 'another organization''s approvals are untouched'
);
rollback to savepoint before_disconnect;
reset role;

-- ===========================================================================
-- Human handoff
-- ===========================================================================

reset role;
set local request.jwt.claims = '{}';
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    handoff_requested_at)
values ('a7000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000002', 'Escalated question', 'manual', 'blocked', 'gov-task-4', now());

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.hand_off_employee_task('a7000000-0000-4000-8000-0000000000d4') $$,
  'P0002', null, 'a viewer cannot take over a task'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.hand_off_employee_task('a7000000-0000-4000-8000-0000000000d4', 'a0000000-0000-4000-8000-000000000004') $$,
  '22023', null, 'a task cannot be handed to a viewer'
);
select throws_ok(
  $$ select public.hand_off_employee_task('a7000000-0000-4000-8000-0000000000d3') $$,
  '55000', null, 'a running task must be paused before a person takes it over'
);
select is(
  public.hand_off_employee_task('a7000000-0000-4000-8000-0000000000d4', 'a0000000-0000-4000-8000-000000000002', 'I will call them.'),
  'handed_off', 'an operator hands the task to an admin'
);
select ok(
  (select status = 'blocked' and handed_off_to = 'a0000000-0000-4000-8000-000000000002'
     and handed_off_by = 'a0000000-0000-4000-8000-000000000003' and handoff_note = 'I will call them.'
   from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d4'),
  'the task records who took it over'
);
select throws_ok(
  $$ select public.reply_to_employee_task('a7000000-0000-4000-8000-0000000000d4', 'Carry on') $$,
  '55000', null, 'the employee cannot be given the task back by replying'
);
select throws_ok(
  $$ select public.complete_handed_off_task('a7000000-0000-4000-8000-0000000000d4', 'done') $$,
  '42501', null, 'only the person who took it over (or an admin) completes it'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  public.complete_handed_off_task('a7000000-0000-4000-8000-0000000000d4', 'done', 'Called and resolved.'),
  'succeeded', 'the person completes the task'
);
select ok(
  (select status = 'succeeded' and result -> 'handoff' ->> 'completedBy' = 'a0000000-0000-4000-8000-000000000002'
   from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d4'),
  'the result says a person completed it'
);
select ok(
  exists (select 1 from public.audit_logs where action = 'task.handed_off' and target_id = 'a7000000-0000-4000-8000-0000000000d4')
  and exists (select 1 from public.audit_logs where action = 'task.completed_by_person' and target_id = 'a7000000-0000-4000-8000-0000000000d4'),
  'taking over and completing are audited'
);

-- ===========================================================================
-- Employee emergency stop
-- ===========================================================================

savepoint before_employee_stop;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.emergency_stop_employee('a2000000-0000-4000-8000-000000000001', 'Sent a wrong email') $$,
  'P0002', null, 'a viewer cannot stop an employee'
);
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.emergency_stop_employee('a2000000-0000-4000-8000-000000000001', 'Sent a wrong email') $$,
  'P0002', null, 'another organization cannot stop it'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.emergency_stop_employee('a2000000-0000-4000-8000-000000000001', '') $$,
  '22023', null, 'a reason is required'
);
select ok(
  (select (r ->> 'paused_tasks')::int >= 2 and (r ->> 'withdrawn_actions')::int >= 1
   from (select public.emergency_stop_employee('a2000000-0000-4000-8000-000000000001', 'Sent a wrong email') as r) as s),
  'an operator stops the employee'
);
select is(
  (select status from public.ai_employees where id = 'a2000000-0000-4000-8000-000000000001'),
  'paused', 'the employee is paused'
);
select ok(
  (select status = 'paused' and paused_from = 'queued' and emergency_paused_at is not null
   from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d2'),
  'its queued task is paused'
);
select ok(
  (select pause_requested_at is not null from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d3'),
  'its running task stops after the current step'
);
select is(
  (select status from public.approval_requests where id = 'a9000000-0000-4000-8000-0000000000d1'),
  'cancelled', 'its pending approvals are withdrawn'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is_empty(
  $$ select id from public.audit_logs where action = 'employee.emergency_stop' $$,
  'operators cannot read the audit log'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select ok(
  exists (select 1 from public.audit_logs where action = 'employee.emergency_stop' and actor_user_id = 'a0000000-0000-4000-8000-000000000003'
    and metadata ->> 'reason' = 'Sent a wrong email'),
  'the stop is audited with who did it and why (admins read it)'
);
rollback to savepoint before_employee_stop;

-- ===========================================================================
-- Workspace emergency stop
-- ===========================================================================

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.set_emergency_stop('a1000000-0000-4000-8000-000000000000', 'Something is wrong') $$,
  'P0002', null, 'an operator cannot stop the workspace'
);
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.set_emergency_stop('a1000000-0000-4000-8000-000000000000', 'Something is wrong') $$,
  'P0002', null, 'another organization cannot stop this workspace'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
create temp table t_stop on commit drop as
  select public.set_emergency_stop('a1000000-0000-4000-8000-000000000000', 'A customer got a wrong email') as result;
grant all on t_stop to public;

select ok(
  (select (result ->> 'cancelled_runs')::int = 1 and (result ->> 'paused_tasks')::int = 2
     and (result ->> 'stopping_tasks')::int = 1 from t_stop),
  'stopping reports what it stopped'
);
select ok(
  (select emergency_stop_at is not null and emergency_stop_by = 'a0000000-0000-4000-8000-000000000002'
   from public.organization_governance where organization_id = 'a1000000-0000-4000-8000-000000000000'),
  'the workspace records the stop'
);
select is(
  (select status from public.workflow_runs where id = 'a6000000-0000-4000-8000-000000000001'),
  'cancelled', 'running workflow runs are cancelled'
);
select is(
  (select status from public.approval_requests where id = 'a9000000-0000-4000-8000-000000000001'),
  'cancelled', 'the run''s pending approval is withdrawn'
);
select ok(
  (select status = 'paused' and paused_from = 'waiting_approval' and emergency_paused_at is not null
   from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d1'),
  'a task waiting for approval is paused'
);
select ok(
  (select a.status = 'cancelled' and e.status = 'cancelled' and e.error ->> 'code' = 'emergency_stop'
   from public.approval_requests as a join public.tool_executions as e on e.id = a.tool_execution_id
   where a.id = 'a9000000-0000-4000-8000-0000000000d1'),
  'its approval and the action are withdrawn'
);
select is(
  (select status from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d2'),
  'paused', 'a queued task is paused'
);
select ok(
  (select status = 'running' and pause_requested_at is not null from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d3'),
  'a running task is asked to stop after its current step'
);
select is(
  (select status from public.ai_employees where id = 'a2000000-0000-4000-8000-000000000001'),
  'active', 'employees keep their status (the stop is a separate switch)'
);
select throws_ok(
  $$ select public.set_emergency_stop('a1000000-0000-4000-8000-000000000000', 'Again') $$,
  '55000', null, 'an active stop cannot be set twice'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'New work', null, 'gov-key-new-01') $$,
  '55000', null, 'no new task can be assigned while stopped'
);
select throws_ok(
  $$ select public.resume_employee_task('a7000000-0000-4000-8000-0000000000d2') $$,
  '55000', null, 'a paused task cannot be resumed while stopped'
);
select throws_ok(
  $$ select public.start_workflow_run('a5000000-0000-4000-8000-000000000001', '{}', 'gov-run-key-01') $$,
  null, null, 'no workflow run can start while stopped'
);

-- A new approval request made during the stop cannot be approved.
reset role;
set local request.jwt.claims = '{}';
insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    input_sha256, status, policy_decision, idempotency_key)
values ('a8000000-0000-4000-8000-0000000000d3', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d1',
  'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
  repeat('c', 64), 'awaiting_approval', 'require_approval', 'gov-tool-3');
insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, action_summary, proposed_action,
    payload_sha256, expires_at)
values ('a9000000-0000-4000-8000-0000000000d3', 'a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-0000000000d3',
  'a7000000-0000-4000-8000-0000000000d1', 'During the stop', '{"action": "gmail.send"}', repeat('c', 64), now() + interval '1 day');
-- And an approved one from before the stop that hasn't started.
insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    input_sha256, status, policy_decision, idempotency_key, pending_input)
values ('a8000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d1',
  'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'gmail.send', 'write_external',
  repeat('b', 64), 'awaiting_approval', 'require_approval', 'gov-tool-4', '{"to": "x@example.test"}');
insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, action_summary, proposed_action,
    payload_sha256, expires_at)
values ('a9000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-0000000000d4',
  'a7000000-0000-4000-8000-0000000000d1', 'Approved before', '{"action": "gmail.send"}', repeat('b', 64), now() + interval '1 day');

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-0000000000d3', 'approved', repeat('c', 64)) $$,
  '55000', null, 'nothing can be approved while stopped'
);
select is(
  (select status from public.decide_approval('a9000000-0000-4000-8000-0000000000d3', 'rejected', repeat('c', 64))),
  'rejected', 'rejecting still works while stopped'
);

-- Force an approved, not yet started action (as if approved just before the stop).
reset role;
set local request.jwt.claims = '{}';
alter table public.approval_requests disable trigger guard_approval_request;
update public.approval_requests set status = 'approved', decided_at = now(), decided_by = 'a0000000-0000-4000-8000-000000000002'
where id = 'a9000000-0000-4000-8000-0000000000d4';
alter table public.approval_requests enable trigger guard_approval_request;
update public.tool_executions set status = 'approved' where id = 'a8000000-0000-4000-8000-0000000000d4';

set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
select is_empty(
  $$ select * from public.claim_employee_tasks(10, 120) where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'the worker claims no task in a stopped workspace, not even one whose worker died'
);
select is_empty(
  $$ select * from public.claim_tool_executions(10, 120) where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'an approved action does not start while stopped'
);
select throws_ok(
  $$ update public.tool_executions set status = 'executing', started_at = now() where id = 'a8000000-0000-4000-8000-0000000000d4' $$,
  '55000', null, 'no code path can start an employee''s action while stopped'
);
select is_empty(
  $$ select * from public.claim_workflow_runs(10, 120) where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'no workflow run is claimed while stopped'
);

-- Another workspace keeps working.
reset role;
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key)
values ('b7000000-0000-4000-8000-0000000000d1', 'b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000002', 'Other workspace', 'manual', 'queued', 'gov-b-task-1');
set local role service_role;
select ok(
  exists (select 1 from public.claim_employee_tasks(10, 120) where task_id = 'b7000000-0000-4000-8000-0000000000d1'),
  'another workspace''s tasks are still claimed'
);

-- Lifting.
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.lift_emergency_stop('a1000000-0000-4000-8000-000000000000', true) $$,
  'P0002', null, 'an operator cannot lift the stop'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select ok(
  (select (r ->> 'resumed_tasks')::int = 2
   from (select public.lift_emergency_stop('a1000000-0000-4000-8000-000000000000', true) as r) as s),
  'an owner lifts the stop and resumes the tasks it paused'
);
select is(
  (select status from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d2'),
  'queued', 'the paused queued task is queued again'
);
select ok(
  (select status = 'waiting_approval' from public.tasks where id = 'a7000000-0000-4000-8000-0000000000d1'),
  'a task with an action still approved goes back to waiting for it'
);
select is(
  (select status from public.approval_requests where id = 'a9000000-0000-4000-8000-0000000000d1'),
  'cancelled', 'withdrawn approvals stay withdrawn after the stop is lifted'
);
select ok(
  exists (select 1 from public.audit_logs where action = 'governance.emergency_stop' and actor_user_id = 'a0000000-0000-4000-8000-000000000002')
  and exists (select 1 from public.audit_logs where action = 'governance.emergency_stop_lifted' and actor_user_id = 'a0000000-0000-4000-8000-000000000001'),
  'stopping and lifting are audited with who did them'
);
select lives_ok(
  $$ select public.assign_employee_task('a2000000-0000-4000-8000-000000000001', 'New work', null, 'gov-key-new-02') $$,
  'work can be assigned again'
);

-- ===========================================================================
-- Evidence retention
-- ===========================================================================

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.set_retention_settings('a1000000-0000-4000-8000-000000000000', 30, 30, 30, false) $$,
  'P0002', null, 'an operator cannot change retention'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select throws_ok(
  $$ select public.set_retention_settings('a1000000-0000-4000-8000-000000000000', 5, 30, 30, false) $$,
  '23514', null, 'retention shorter than 30 days is refused'
);
select lives_ok(
  $$ select public.set_retention_settings('a1000000-0000-4000-8000-000000000000', 30, 30, 30, true) $$,
  'an admin sets retention with a hold'
);
select throws_ok(
  $$ select public.purge_expired_task_data() $$,
  '42501', null, 'members cannot run the purge'
);

reset role;
-- Old data on a finished task.
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    created_at, started_at, completed_at)
values ('a7000000-0000-4000-8000-0000000000d5', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000002', 'Old task', 'manual', 'succeeded', 'gov-task-5',
  now() - interval '100 days', now() - interval '100 days', now() - interval '99 days');
insert into public.task_evidence (organization_id, task_id, kind, title, excerpt, created_at)
values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d5', 'knowledge_passage', 'FAQ',
  'Refunds are accepted within 30 days.', now() - interval '99 days');
insert into public.task_evidence (organization_id, task_id, kind, title, excerpt, created_at)
values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d2', 'knowledge_passage', 'FAQ',
  'Still running.', now() - interval '99 days');
insert into public.execution_events (organization_id, task_id, event_type, message, created_at)
values ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d5', 'task.started', 'Old event', now() - interval '99 days');
insert into public.tool_executions (id, organization_id, task_id, tool_key, risk_level, input_redacted, input_sha256,
    output_redacted, status, policy_decision, idempotency_key, started_at, finished_at, created_at)
values ('a8000000-0000-4000-8000-0000000000d5', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000d5',
  'hubspot.contacts.search', 'read', '{"email": "dana@example.test"}', repeat('9', 64), '{"total": 1}', 'succeeded', 'allow',
  'gov-tool-5', now() - interval '99 days', now() - interval '99 days', now() - interval '99 days');

set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
select is(
  (select coalesce(public.purge_expired_task_data() -> 'a1000000-0000-4000-8000-000000000000', 'null'::jsonb)),
  'null'::jsonb, 'a hold suspends purging'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select public.set_retention_settings('a1000000-0000-4000-8000-000000000000', 30, 30, 30, false);

set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
create temp table t_purge on commit drop as select public.purge_expired_task_data() as result;
select ok(
  (select (result -> 'a1000000-0000-4000-8000-000000000000' ->> 'evidence')::int = 1 from t_purge),
  'old evidence of finished tasks is purged'
);
select ok(
  exists (select 1 from public.task_evidence where task_id = 'a7000000-0000-4000-8000-0000000000d2'),
  'evidence of unfinished work is kept'
);
select is_empty(
  $$ select id from public.execution_events where message = 'Old event' $$,
  'old execution events are purged'
);
select ok(
  (select input_redacted = '{}'::jsonb and output_redacted is null and payload_purged_at is not null and input_sha256 = repeat('9', 64)
   from public.tool_executions where id = 'a8000000-0000-4000-8000-0000000000d5'),
  'old action payloads are cleared; the fingerprint and outcome stay'
);
select ok(
  exists (select 1 from public.task_evidence where task_id = 'b7000000-0000-4000-8000-000000000001')
  or not exists (select 1 from public.task_evidence where organization_id = 'b1000000-0000-4000-8000-000000000000'),
  'another workspace''s data follows its own retention'
);
select ok(
  exists (select 1 from public.audit_logs where action = 'governance.retention_purged' and actor_type = 'system'
    and organization_id = 'a1000000-0000-4000-8000-000000000000'),
  'the purge is audited'
);
select throws_ok(
  $$ update public.tool_executions set input_redacted = '{}' where id = 'a8000000-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'outside the purge, payloads still cannot be changed'
);

-- ===========================================================================
-- Audit trail
-- ===========================================================================

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is_empty($$ select id from public.audit_logs $$, 'viewers cannot read the audit log');
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty(
  $$ select id from public.audit_logs where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'another organization cannot read this audit log'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select ok(
  (select count(*) >= 8 from public.audit_logs where organization_id = 'a1000000-0000-4000-8000-000000000000'
    and action in ('governance.emergency_stop', 'governance.emergency_stop_lifted', 'task.handed_off', 'task.completed_by_person',
      'governance.retention_changed', 'organization_policies.insert', 'organization_policies.update', 'organization_policies.delete',
      'approval_requests.update')),
  'admins read the governance trail'
);
select throws_ok($$ delete from public.audit_logs $$, '42501', null, 'members cannot delete audit entries');
reset role;
select throws_ok(
  $$ update public.audit_logs set action = 'tampered.entry' where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  '42501', null, 'audit entries cannot be changed even by the database owner'
);

select * from finish();
rollback;

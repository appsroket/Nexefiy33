-- Roles and membership: least privilege per role, membership administration
-- rules, last-owner protection, revocation, and invitations.
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

create temp table invitation_tokens (label text primary key, token text not null);
grant all on invitation_tokens to authenticated;

-- Viewer ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';

select isnt_empty('select id from public.ai_employees', 'viewers can read employees');
select isnt_empty('select id from public.outcome_records', 'viewers can read outcomes');
select throws_ok(
  $$ insert into public.ai_employees (organization_id, name, role_category)
     values ('a1000000-0000-4000-8000-000000000000', 'Viewer Bot', 'custom') $$,
  '42501', null, 'viewers cannot create employees'
);
select is_empty(
  $$ update public.ai_employees set name = 'Renamed' where organization_id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'viewers cannot change employees'
);
select is_empty(
  $$ delete from public.ai_employees where organization_id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'viewers cannot delete employees'
);
select is_empty(
  $$ update public.company_settings set description = 'x'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' returning organization_id $$,
  'viewers cannot change company settings'
);
select throws_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type)
     values ('a1000000-0000-4000-8000-000000000000', 'Notes', 'text') $$,
  '42501', null, 'viewers cannot add knowledge'
);
select is_empty(
  $$ update public.organization_members set role = 'admin'
     where user_id = 'a0000000-0000-4000-8000-000000000004' returning user_id $$,
  'viewers cannot promote themselves'
);
select throws_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-000000000001', 'approved', repeat('1', 64)) $$,
  'P0002', null, 'viewers cannot decide approvals'
);
select throws_ok(
  $$ select * from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'friend@example.test', 'viewer') $$,
  '42501', null, 'viewers cannot invite members'
);
select is_empty('select id from public.audit_logs', 'viewers cannot read the audit log');
select is_empty('select id from public.subscriptions', 'viewers cannot read billing subscriptions');
select is_empty('select id from public.usage_records', 'viewers cannot read usage and cost');

-- Operator ---------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select lives_ok(
  $$ insert into public.ai_employees (organization_id, name, role_category)
     values ('a1000000-0000-4000-8000-000000000000', 'Researcher', 'research') $$,
  'operators can create employees'
);
select lives_ok(
  $$ insert into public.employee_versions (organization_id, employee_id, instructions, config)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'Be concise.',
       '{"modelTier": "deep", "limits": {"maxTurnsPerTask": 5, "maxToolCallsPerTask": 5, "maxCostUsdPerTask": 2}}') $$,
  'operators can publish employee configuration versions'
);
select is(
  (select max(version) from public.employee_versions where employee_id = 'a2000000-0000-4000-8000-000000000001'),
  2,
  'the database assigns the next version number'
);
select lives_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type)
     values ('a1000000-0000-4000-8000-000000000000', 'Pricing notes', 'text') $$,
  'operators can add knowledge'
);
select throws_ok(
  $$ insert into public.employee_tool_permissions (organization_id, employee_id, tool_key)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'calendar.create_event') $$,
  '42501', null, 'operators cannot grant tools to employees'
);
select throws_ok(
  $$ insert into public.organization_policies (organization_id, name, policy)
     values ('a1000000-0000-4000-8000-000000000000', 'Loose', '{"rules": []}') $$,
  '42501', null, 'operators cannot change approval policies'
);
select is_empty(
  $$ update public.integrations set display_name = 'Renamed' where organization_id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'operators cannot manage integrations'
);
select is_empty(
  $$ update public.organizations set name = 'Renamed' where id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'operators cannot rename the organization'
);
select is_empty(
  $$ update public.organization_members set role = 'operator'
     where user_id = 'a0000000-0000-4000-8000-000000000004' returning user_id $$,
  'operators cannot administer membership'
);
select throws_ok(
  $$ select * from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'friend@example.test', 'viewer') $$,
  '42501', null, 'operators cannot invite members'
);
select is_empty('select id from public.subscriptions', 'operators cannot read billing subscriptions');
select is_empty('select id from public.usage_records', 'operators cannot read usage and cost');
select is_empty('select id from public.audit_logs', 'operators cannot read the audit log');
select is_empty(
  $$ delete from public.organizations where id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'operators cannot delete the organization'
);
select lives_ok(
  $$ select public.decide_approval('a9000000-0000-4000-8000-000000000001', 'approved', repeat('1', 64), 'Looks right') $$,
  'operators can decide approvals that require an operator'
);
select is(
  (select status from public.tool_executions where id = 'a8000000-0000-4000-8000-000000000001'),
  'approved',
  'approving marks the tool execution approved'
);

-- Admin ------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select isnt_empty('select id from public.audit_logs', 'admins can read the audit log');
select isnt_empty('select id from public.subscriptions', 'admins can read billing subscriptions');
select isnt_empty(
  $$ update public.integrations set display_name = 'Shared inbox'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'admins can manage integrations'
);
select lives_ok(
  $$ insert into public.employee_tool_permissions (organization_id, employee_id, tool_key)
     values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001', 'calendar.create_event') $$,
  'admins can grant tools to employees'
);
select isnt_empty(
  $$ update public.organization_members set role = 'viewer'
     where user_id = 'a0000000-0000-4000-8000-000000000003' returning user_id $$,
  'admins can change an operator''s role'
);
select throws_ok(
  $$ update public.organization_members set role = 'admin' where user_id = 'a0000000-0000-4000-8000-000000000004' $$,
  '42501', null, 'admins cannot promote anyone to admin'
);
select throws_ok(
  $$ update public.organization_members set role = 'viewer' where user_id = 'a0000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'admins cannot demote the owner'
);
select throws_ok(
  $$ delete from public.organization_members where user_id = 'a0000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'admins cannot remove the owner'
);
select throws_ok(
  $$ update public.organization_members set organization_id = 'b1000000-0000-4000-8000-000000000000'
     where user_id = 'a0000000-0000-4000-8000-000000000004' $$,
  '42501', null, 'a membership cannot be moved to another organization'
);
select lives_ok(
  $$ select * from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'new-operator@example.test', 'operator') $$,
  'admins can invite operators'
);
select throws_ok(
  $$ select * from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'new-admin@example.test', 'admin') $$,
  '42501', null, 'only owners can invite admins'
);
select throws_ok(
  'select token_hash from public.organization_invitations', '42501', null,
  'invitation token hashes are not readable'
);

-- Revocation: access ends immediately.
select isnt_empty(
  $$ update public.organization_members set status = 'revoked'
     where user_id = 'a0000000-0000-4000-8000-000000000004' returning user_id $$,
  'admins can revoke a viewer'
);
select isnt_empty(
  $$ delete from public.organization_members where user_id = 'a0000000-0000-4000-8000-000000000003' returning user_id $$,
  'admins can remove a member'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is_empty('select id from public.organizations', 'a revoked member no longer sees the organization');
select is_empty('select id from public.ai_employees', 'a revoked member no longer sees employees');
select is_empty('select id from public.approval_requests', 'a revoked member no longer sees approvals');
select is_empty(
  $$ select id from public.knowledge_chunks $$,
  'a revoked member no longer sees knowledge'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is_empty('select id from public.organizations', 'a removed member no longer sees the organization');
select throws_ok(
  $$ insert into public.ai_employees (organization_id, name, role_category)
     values ('a1000000-0000-4000-8000-000000000000', 'Ghost', 'custom') $$,
  '42501', null, 'a removed member can no longer write'
);

reset role;
select isnt(
  (select revoked_at from public.organization_members where user_id = 'a0000000-0000-4000-8000-000000000004'),
  null,
  'revocation records when it happened'
);
select is(
  (select revoked_by from public.organization_members where user_id = 'a0000000-0000-4000-8000-000000000004'),
  'a0000000-0000-4000-8000-000000000002'::uuid,
  'revocation records who did it'
);

-- Owner and last-owner protection -------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select throws_ok(
  $$ update public.organization_members set role = 'admin' where user_id = 'a0000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'the last owner cannot step down'
);
select throws_ok(
  $$ delete from public.organization_members where user_id = 'a0000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'the last owner cannot leave'
);
select isnt_empty(
  $$ update public.organization_members set role = 'owner'
     where user_id = 'a0000000-0000-4000-8000-000000000002' returning user_id $$,
  'owners can promote an admin to owner'
);
select lives_ok(
  $$ update public.organization_members set role = 'admin' where user_id = 'a0000000-0000-4000-8000-000000000001' $$,
  'an owner can step down once another owner exists'
);

-- Invitations ----------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
insert into invitation_tokens (label, token)
  select 'outsider', token from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'Outsider@Example.test', 'viewer');

set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.accept_invitation((select token from invitation_tokens where label = 'outsider')) $$,
  '22023', null, 'an invitation cannot be accepted by someone with a different email'
);

set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.accept_invitation('not-a-real-token') $$,
  '22023', null, 'an unknown token is rejected'
);
select is(
  (select public.accept_invitation((select token from invitation_tokens where label = 'outsider'))),
  'a1000000-0000-4000-8000-000000000000'::uuid,
  'the invited person can accept with the token'
);
select is(
  (select role from public.organization_members where user_id = 'c0000000-0000-4000-8000-000000000001'),
  'viewer',
  'accepting grants the invited role'
);
select throws_ok(
  $$ select public.accept_invitation((select token from invitation_tokens where label = 'outsider')) $$,
  '22023', null, 'an invitation token works only once'
);

select * from finish();
rollback;

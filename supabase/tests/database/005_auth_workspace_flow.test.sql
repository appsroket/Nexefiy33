-- Auth and workspace flow: creating workspaces, invitation lookup, expired and
-- revoked invitations, re-invitation, removed members rejoining, role changes
-- taking effect at once, profiles, leaving and deleting a workspace, and
-- attempts to act on another organization.
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

-- Signed-out visitors -----------------------------------------------------------
set local role anon;
select throws_ok(
  $$ select public.create_organization('Anon Co', 'anon-co') $$,
  '42501', null, 'signed-out visitors cannot create workspaces'
);
select throws_ok(
  $$ select * from public.get_invitation(repeat('a', 64)) $$,
  '42501', null, 'signed-out visitors cannot look up invitations'
);

-- Creating a workspace -----------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select is(
  (select slug from public.create_organization('  Outsider Co  ', 'Outsider-Co')),
  'outsider-co',
  'any signed-in person can create a workspace (name trimmed, address lowercased)'
);
select is(
  (select m.role from public.organization_members as m
   join public.organizations as o on o.id = m.organization_id where o.slug = 'outsider-co'),
  'owner',
  'the creator becomes the owner'
);
select isnt_empty(
  $$ select 1 from public.company_settings as s
     join public.organizations as o on o.id = s.organization_id where o.slug = 'outsider-co' $$,
  'workspace settings are created with the workspace'
);
select throws_ok(
  $$ select public.create_organization('Copy', 'org-a-test') $$,
  '23505', null, 'workspace addresses are unique'
);
select throws_ok(
  $$ select public.create_organization('Bad', 'not a slug!') $$,
  '23514', null, 'workspace addresses only use lowercase letters, numbers and dashes'
);
select is(
  (select count(*)::int from public.organizations), 1,
  'a new owner sees only their own workspace'
);
select is_empty(
  $$ select 1 from public.organization_members where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'and none of another workspace''s members'
);
select is_empty(
  $$ select 1 from public.profiles where id = 'a0000000-0000-4000-8000-000000000001' $$,
  'and no profiles of people they share no workspace with'
);

-- Inviting -----------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
insert into invitation_tokens (label, token)
  select 'outsider', token from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'outsider@example.test', 'operator');
insert into invitation_tokens (label, token)
  select 'newcomer', token from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'newcomer@example.test', 'viewer');

select throws_ok(
  $$ select public.create_invitation('a1000000-0000-4000-8000-000000000000', ' Outsider@Example.test ', 'viewer') $$,
  '23505', 'this address already has a pending invitation',
  'a second pending invitation for the same address is refused'
);
select throws_ok(
  $$ select public.create_invitation('a1000000-0000-4000-8000-000000000000', 'viewer-a@example.test', 'viewer') $$,
  '23505', 'this person is already a member',
  'current members cannot be invited'
);
select throws_ok(
  $$ select public.create_invitation('b1000000-0000-4000-8000-000000000000', 'someone@example.test', 'viewer') $$,
  '42501', null, 'admins cannot invite people to another workspace'
);
select throws_ok(
  $$ select public.create_invitation('a1000000-0000-4000-8000-000000000000', 'someone@example.test', 'owner') $$,
  '22023', null, 'nobody can be invited straight in as owner'
);

-- Looking an invitation up ----------------------------------------------------------
set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select results_eq(
  $$ select organization_name, role, status, invited_email, email_matches, already_member
     from public.get_invitation((select token from invitation_tokens where label = 'outsider')) $$,
  $$ values ('Org A'::text, 'operator'::text, 'pending'::text, 'outsider@example.test'::text, true, false) $$,
  'the invited person sees the workspace, role and status before accepting'
);
select is_empty(
  $$ select * from public.get_invitation(repeat('0', 64)) $$,
  'an unknown token reveals nothing'
);
select is_empty(
  $$ select * from public.get_invitation('not-a-token') $$,
  'a malformed token reveals nothing'
);
select is_empty(
  $$ select id from public.organization_invitations $$,
  'holding a token does not let anyone list invitations'
);

set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  (select email_matches from public.get_invitation((select token from invitation_tokens where label = 'outsider'))),
  false,
  'someone signed in with a different email is told it does not match'
);
select is_empty(
  $$ select id from public.organization_invitations where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'another workspace''s owner cannot see these invitations'
);
select is_empty(
  $$ update public.organization_invitations set status = 'revoked'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'another workspace''s owner cannot revoke these invitations'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is(
  (select already_member from public.get_invitation((select token from invitation_tokens where label = 'outsider'))),
  true,
  'a current member is told they already belong'
);

-- Expired invitations ----------------------------------------------------------------
reset role;
update public.organization_invitations
set created_at = now() - interval '8 days', expires_at = now() - interval '1 day'
where email = 'outsider@example.test';
set local role authenticated;

set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  (select status from public.get_invitation((select token from invitation_tokens where label = 'outsider'))),
  'expired',
  'an invitation past its expiry shows as expired'
);
select throws_ok(
  $$ select public.accept_invitation((select token from invitation_tokens where label = 'outsider')) $$,
  '22023', null, 'an expired invitation cannot be accepted'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
insert into invitation_tokens (label, token)
  select 'outsider-again', token from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'outsider@example.test', 'viewer');
select is(
  (select count(*)::int from invitation_tokens where label = 'outsider-again'), 1,
  'an address whose invitation expired can be invited again'
);
select is(
  (select status from public.organization_invitations where email = 'outsider@example.test' and role = 'operator'),
  'expired',
  're-inviting marks the old invitation expired'
);

-- Revoked invitations ------------------------------------------------------------------
select isnt_empty(
  $$ update public.organization_invitations set status = 'revoked'
     where email = 'outsider@example.test' and status = 'pending' returning id $$,
  'admins can revoke a pending invitation'
);
set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  (select status from public.get_invitation((select token from invitation_tokens where label = 'outsider-again'))),
  'revoked',
  'a revoked invitation shows as revoked'
);
select throws_ok(
  $$ select public.accept_invitation((select token from invitation_tokens where label = 'outsider-again')) $$,
  '22023', null, 'a revoked invitation cannot be accepted'
);
select is_empty(
  $$ select id from public.organizations where id = 'a1000000-0000-4000-8000-000000000000' $$,
  'failed acceptances grant no access'
);

-- Removed members can be invited back -----------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select isnt_empty(
  $$ update public.organization_members set status = 'revoked'
     where organization_id = 'a1000000-0000-4000-8000-000000000000'
       and user_id = 'a0000000-0000-4000-8000-000000000003' returning user_id $$,
  'admins can remove an operator'
);
insert into invitation_tokens (label, token)
  select 'operator-back', token from public.create_invitation('a1000000-0000-4000-8000-000000000000', 'operator-a@example.test', 'viewer');

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is_empty($$ select id from public.ai_employees $$, 'a removed member sees no workspace data');
select is(
  (select already_member from public.get_invitation((select token from invitation_tokens where label = 'operator-back'))),
  false,
  'a removed member is not treated as a current member'
);
select is(
  (select public.accept_invitation((select token from invitation_tokens where label = 'operator-back'))),
  'a1000000-0000-4000-8000-000000000000'::uuid,
  'a removed member can accept a new invitation'
);
select is(
  (select role || '/' || status from public.organization_members
   where organization_id = 'a1000000-0000-4000-8000-000000000000' and user_id = 'a0000000-0000-4000-8000-000000000003'),
  'viewer/active',
  'rejoining uses the role from the new invitation'
);
select isnt_empty($$ select id from public.ai_employees $$, 'rejoining restores access');

-- Role changes take effect immediately ----------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select isnt_empty(
  $$ update public.organization_members set role = 'viewer'
     where organization_id = 'a1000000-0000-4000-8000-000000000000'
       and user_id = 'a0000000-0000-4000-8000-000000000002' returning user_id $$,
  'the owner can demote an admin'
);
select isnt_empty(
  $$ update public.organization_members set role = 'admin'
     where organization_id = 'a1000000-0000-4000-8000-000000000000'
       and user_id = 'a0000000-0000-4000-8000-000000000004' returning user_id $$,
  'the owner can promote a viewer to admin'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is_empty(
  $$ update public.company_settings set industry = 'Changed'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' returning organization_id $$,
  'a demoted admin loses admin rights at once'
);
select throws_ok(
  $$ select public.create_invitation('a1000000-0000-4000-8000-000000000000', 'late@example.test', 'viewer') $$,
  '42501', null, 'and can no longer invite'
);
select is_empty($$ select id from public.organization_invitations $$, 'and can no longer see invitations');

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select isnt_empty(
  $$ update public.company_settings set industry = 'Logistics'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' returning organization_id $$,
  'a promoted admin gains admin rights at once'
);
select isnt_empty($$ select id from public.audit_logs $$, 'including reading the audit log');

-- Other organizations ------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty(
  $$ update public.company_settings set industry = 'Hijacked'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' returning organization_id $$,
  'another workspace''s owner cannot change these settings'
);
select is_empty(
  $$ update public.organizations set name = 'Hijacked'
     where id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'another workspace''s owner cannot rename this workspace'
);
select is_empty(
  $$ update public.organization_members set role = 'viewer'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' returning user_id $$,
  'another workspace''s owner cannot change these roles'
);
select is_empty(
  $$ delete from public.organization_members
     where organization_id = 'a1000000-0000-4000-8000-000000000000' returning user_id $$,
  'another workspace''s owner cannot remove these members'
);
select is_empty(
  $$ delete from public.organizations where id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'another workspace''s owner cannot delete this workspace'
);

-- Profiles ----------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select isnt_empty(
  $$ update public.profiles set full_name = 'Viewer Renamed'
     where id = 'a0000000-0000-4000-8000-000000000004' returning id $$,
  'people can change their own name'
);
select is_empty(
  $$ update public.profiles set full_name = 'Not You'
     where id = 'a0000000-0000-4000-8000-000000000001' returning id $$,
  'but not someone else''s'
);
select throws_ok(
  $$ update public.profiles set email = 'other@example.test' where id = 'a0000000-0000-4000-8000-000000000004' $$,
  '42501', null, 'the email on a profile cannot be changed directly'
);
select isnt_empty(
  $$ select 1 from public.profiles where id = 'a0000000-0000-4000-8000-000000000001' $$,
  'co-members can see each other''s profiles'
);

-- Leaving --------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select isnt_empty(
  $$ delete from public.organization_members
     where organization_id = 'a1000000-0000-4000-8000-000000000000'
       and user_id = 'a0000000-0000-4000-8000-000000000003' returning user_id $$,
  'a member can leave a workspace'
);
select is_empty($$ select id from public.organizations $$, 'after leaving they no longer see it');

-- Deleting a workspace ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is_empty(
  $$ delete from public.organizations where id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'admins cannot delete the workspace'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select isnt_empty(
  $$ delete from public.organizations where id = 'a1000000-0000-4000-8000-000000000000' returning id $$,
  'the owner can delete the workspace'
);

reset role;
select is(
  (select count(*)::int from public.ai_employees where organization_id = 'a1000000-0000-4000-8000-000000000000')
    + (select count(*)::int from public.organization_members where organization_id = 'a1000000-0000-4000-8000-000000000000')
    + (select count(*)::int from public.organization_invitations where organization_id = 'a1000000-0000-4000-8000-000000000000')
    + (select count(*)::int from public.approval_requests where organization_id = 'a1000000-0000-4000-8000-000000000000'),
  0,
  'deleting a workspace removes its members, invitations and data'
);
select is(
  (select count(*)::int from public.ai_employees where organization_id = 'b1000000-0000-4000-8000-000000000000'),
  1,
  'other workspaces are untouched'
);
select isnt_empty(
  $$ select 1 from public.audit_logs
     where organization_id = 'a1000000-0000-4000-8000-000000000000' and action = 'organizations.delete' $$,
  'the deletion is kept in the audit log'
);

select * from finish();
rollback;

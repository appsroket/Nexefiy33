-- Built-in skills catalog (Phase 13): the seeded skills, their procedures and
-- tools, the retired email and calendar skills, and reserved built-in keys
-- (a workspace's own skill can't reuse one).
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

-- Catalog ------------------------------------------------------------------------

select is(
  (select count(*)::int from public.skills where organization_id is null and status = 'active'),
  30,
  'thirty built-in skills are active (src/modules/employees/domain/skills.ts, available ones)'
);
select is_empty(
  $$ select key from public.skills
     where organization_id is null and status = 'active'
       and (instructions is null or btrim(instructions) = '' or description is null) $$,
  'every active built-in skill has a description and a procedure'
);
select is_empty(
  $$ select s.key from public.skills as s, unnest(s.tool_keys) as t(tool_key)
     where s.organization_id is null and s.status = 'active'
       and t.tool_key not in ('knowledge.search', 'hubspot.contacts.search', 'hubspot.contacts.upsert', 'hubspot.notes.create',
         'slack.channels.list', 'slack.messages.post') $$,
  'active built-in skills list only tools that exist'
);
select is_empty(
  $$ select key from public.skills where organization_id is null and status = 'active'
     and (key like 'voice.%' or key in ('sales.outreach', 'sales.lead_research', 'support.ticketing', 'assistant.scheduling')) $$,
  'skills that need telephony, email, calendars, web research or a help desk are not seeded'
);
select set_eq(
  $$ select key from public.skills where organization_id is null and status = 'deprecated' $$,
  array['email.correspondence', 'calendar.scheduling'],
  'the email and calendar skills stay retired'
);

-- Reserved keys --------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select throws_ok(
  $$ insert into public.skills (organization_id, key, name, category)
     values ('a1000000-0000-4000-8000-000000000000', 'support.cited_answers', 'Our answers', 'support') $$,
  '23505', null,
  'an operator cannot create a skill with a built-in key'
);
select throws_ok(
  $$ update public.skills set key = 'crm.records' where id = 'ab000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'an operator cannot change a skill''s key at all'
);
select lives_ok(
  $$ insert into public.skills (organization_id, key, name, category, instructions)
     values ('a1000000-0000-4000-8000-000000000000', 'custom.renewals', 'Renewals', 'custom', 'Check renewal dates.') $$,
  'an operator can still create a skill with its own key'
);
select is(
  (select count(*)::int from public.skills where organization_id is null and status = 'active'),
  30,
  'members read every active built-in skill'
);

reset role;
select throws_ok(
  $$ update public.skills set key = 'crm.records' where id = 'ab000000-0000-4000-8000-000000000001' $$,
  '23505', null,
  'not even the server can rename a workspace skill to a built-in key'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty($$ select id from public.skills where organization_id is not null $$, 'an outsider sees no workspace skills');

reset role;
select * from finish();
rollback;

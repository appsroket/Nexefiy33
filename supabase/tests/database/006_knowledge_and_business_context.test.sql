-- Knowledge and business context: roles, tenant isolation, storage folders,
-- the processing queue, and retrieval boundaries.
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
    update public.ai_employees set current_version_id = (p || '2' || id_of || '2')::uuid, status = 'active'
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

-- Extra data for this file (as the migration owner) ----------------------------
-- Org A: a failed file source and a processing source; one ready chunk per org
-- comes from the fixture ("Refunds are accepted within 30 days.").
insert into public.knowledge_sources (id, organization_id, name, source_type, status, storage_bucket, storage_path,
    mime_type, error_message, created_by)
values
  ('a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'Handbook.pdf', 'file', 'failed',
    'knowledge', 'a1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000001/Handbook.pdf',
    'application/pdf', 'The file could not be read.', 'a0000000-0000-4000-8000-000000000003');
insert into public.knowledge_sources (id, organization_id, name, source_type, status, processing_started_at,
    processing_attempts, created_by)
values
  ('a3000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000', 'Pasted notes', 'text',
    'processing', now(), 1, 'a0000000-0000-4000-8000-000000000003');
insert into public.knowledge_chunks (organization_id, source_id, chunk_index, content, content_sha256)
values ('a1000000-0000-4000-8000-000000000000', 'a3000000-0000-4000-8000-000000000003', 0,
  'Refund exceptions are handled by the finance team.', repeat('b', 64));

insert into storage.objects (bucket_id, name) values
  ('knowledge', 'a1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000001/Handbook.pdf'),
  ('knowledge', 'b1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000002/Prices.pdf');

-- Structure --------------------------------------------------------------------

select ok(
  (select not public and file_size_limit = 20971520 from storage.buckets where id = 'knowledge'),
  'the knowledge bucket is private and limited to 20 MB'
);
select ok(
  not has_column_privilege('authenticated', 'public.knowledge_sources', 'status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.knowledge_sources', 'processing_attempts', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.knowledge_sources', 'error_message', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.knowledge_sources', 'context_item_id', 'INSERT'),
  'clients cannot write processing state or link sources to context items'
);
select ok(
  not has_column_privilege('authenticated', 'public.business_context_items', 'kind', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.business_context_items', 'organization_id', 'UPDATE'),
  'clients cannot change the kind or organization of a context item'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_knowledge_sources(integer, uuid, integer, integer)', 'EXECUTE'),
  'clients cannot claim sources from the processing queue'
);

-- Business context: roles -------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select lives_ok(
  $$ insert into public.business_context_items (id, organization_id, kind, title, body)
     values ('ae000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'faq',
       'Do you ship abroad?', 'Yes, to the EU and the UK.') $$,
  'an operator can add an FAQ'
);
select lives_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, body, attributes)
     values ('a1000000-0000-4000-8000-000000000000', 'goal', 'Faster replies', '', '{"metric": "First reply time", "target": "< 1 hour", "period": "monthly"}') $$,
  'an operator can add a goal with KPI attributes'
);
select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, body, attributes)
     values ('a1000000-0000-4000-8000-000000000000', 'template', 'Welcome', 'Hello {{name}}', '{"channel": "email"}') $$,
  '42501', null,
  'an operator cannot add a communication template (admins approve wording)'
);
select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, attributes)
     values ('a1000000-0000-4000-8000-000000000000', 'escalation_contact', 'Dana', '{"email": "dana@example.test"}') $$,
  '42501', null,
  'an operator cannot add an escalation contact'
);
select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, body)
     values ('b1000000-0000-4000-8000-000000000000', 'faq', 'Injected?', 'Into another org') $$,
  '42501', null,
  'an operator cannot add context to another organization'
);
select throws_ok(
  $$ update public.business_context_items set kind = 'template' where id = 'ae000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'an operator cannot change an entry''s kind'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select lives_ok(
  $$ insert into public.business_context_items (id, organization_id, kind, title, body, attributes)
     values ('ae000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'template',
       'Refund confirmation', 'Hi {{name}}, your refund is on its way.', '{"channel": "email", "subject": "Your refund"}') $$,
  'an admin can add a communication template'
);
select lives_ok(
  $$ insert into public.business_context_items (id, organization_id, kind, title, body, attributes)
     values ('ae000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000', 'escalation_contact',
       'Dana Lee', 'Billing disputes over 500 EUR', '{"role": "Finance lead", "email": "dana@example.test", "priority": 1}') $$,
  'an admin can add an escalation contact'
);
select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, attributes)
     values ('a1000000-0000-4000-8000-000000000000', 'escalation_contact', 'No way to reach', '{"role": "Ghost"}') $$,
  '23514', null,
  'an escalation contact needs an email or a phone number'
);
select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, body, attributes)
     values ('a1000000-0000-4000-8000-000000000000', 'template', 'No channel', 'Hello', '{}') $$,
  '23514', null,
  'a template needs a channel'
);
select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, body)
     values ('a1000000-0000-4000-8000-000000000000', 'faq', 'Empty answer', '  ') $$,
  '23514', null,
  'an FAQ needs an answer'
);
select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, body, attributes)
     values ('a1000000-0000-4000-8000-000000000000', 'faq', 'Extra', 'Answer', '{"approved": true}') $$,
  '23514', null,
  'unknown attributes are rejected'
);
select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, body)
     values ('a1000000-0000-4000-8000-000000000000', 'sop', 'Deploy', 'Use key sk-ant-api03-abcdefghijklmnop') $$,
  '23514', null,
  'credentials cannot be stored in context text'
);
select lives_ok(
  $$ update public.company_settings
     set brand_voice = 'Warm and direct.',
         settings = '{"schemaVersion": 1, "profile": {"headquarters": "Lisbon", "teamSize": "11-50"},
           "operatingHours": {"weekly": {"mon": [{"open": "09:00", "close": "17:30"}], "sat": []}, "notes": "Closed on public holidays"},
           "brandVoice": {"formality": "neutral", "tone": ["warm", "direct"], "avoidPhrases": ["ASAP"]}}'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'an admin can save the company profile, operating hours and brand voice'
);
select throws_ok(
  $$ update public.company_settings set settings = '{"operatingHours": {"weekly": {"mon": [{"open": "9am", "close": "5pm"}]}}}'
     where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  '23514', null,
  'malformed operating hours are rejected'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

with changed as (
  update public.business_context_items set body = 'Changed by an operator'
  where id = 'ae000000-0000-4000-8000-000000000002' returning 1)
select is(count(*)::int, 0, 'an operator cannot edit a template') from changed;
with removed as (
  delete from public.business_context_items where id = 'ae000000-0000-4000-8000-000000000003' returning 1)
select is(count(*)::int, 0, 'an operator cannot delete an escalation contact') from removed;
with changed as (
  update public.company_settings set brand_voice = 'Operator voice'
  where organization_id = 'a1000000-0000-4000-8000-000000000000' returning 1)
select is(count(*)::int, 0, 'an operator cannot change the company profile') from changed;

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';

select throws_ok(
  $$ insert into public.business_context_items (organization_id, kind, title, body)
     values ('a1000000-0000-4000-8000-000000000000', 'faq', 'Viewer question', 'Viewer answer') $$,
  '42501', null,
  'a viewer cannot add context'
);
select is(
  (select count(*)::int from public.business_context_items where organization_id = 'a1000000-0000-4000-8000-000000000000'),
  4,
  'a viewer can read the organization''s context'
);

-- Business context: isolation ---------------------------------------------------
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select is_empty(
  $$ select id from public.business_context_items where organization_id = 'a1000000-0000-4000-8000-000000000000' $$,
  'another organization''s owner sees none of its context'
);
with changed as (
  update public.business_context_items set body = 'Hijacked' where organization_id = 'a1000000-0000-4000-8000-000000000000' returning 1)
select is(count(*)::int, 0, 'another organization''s owner cannot edit its context') from changed;
with removed as (
  delete from public.business_context_items where organization_id = 'a1000000-0000-4000-8000-000000000000' returning 1)
select is(count(*)::int, 0, 'another organization''s owner cannot delete its context') from removed;

set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty('select id from public.business_context_items', 'an outsider sees no context');

-- Business context indexing -----------------------------------------------------
reset role;

select is(
  (select source_type || '|' || status || '|' || name from public.knowledge_sources
   where context_item_id = 'ae000000-0000-4000-8000-000000000001'),
  'business_context|pending|FAQ: Do you ship abroad?',
  'adding an FAQ queues it for indexing as a business context source'
);
select is_empty(
  $$ select id from public.knowledge_sources where context_item_id = 'ae000000-0000-4000-8000-000000000003' $$,
  'escalation contacts are not indexed for search'
);

update public.knowledge_sources set status = 'ready', processing_attempts = 1
  where context_item_id = 'ae000000-0000-4000-8000-000000000001';
update public.business_context_items set position = 5 where id = 'ae000000-0000-4000-8000-000000000001';
select is(
  (select status from public.knowledge_sources where context_item_id = 'ae000000-0000-4000-8000-000000000001'),
  'ready',
  'reordering an entry does not re-index it'
);
update public.business_context_items set body = 'Yes, worldwide.' where id = 'ae000000-0000-4000-8000-000000000001';
select is(
  (select status || '|' || processing_attempts from public.knowledge_sources
   where context_item_id = 'ae000000-0000-4000-8000-000000000001'),
  'pending|0',
  'editing an entry queues it for re-indexing'
);
update public.business_context_items set status = 'archived' where id = 'ae000000-0000-4000-8000-000000000001';
select is(
  (select status from public.knowledge_sources where context_item_id = 'ae000000-0000-4000-8000-000000000001'),
  'archived',
  'archiving an entry removes it from search'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

with removed as (
  delete from public.knowledge_sources where context_item_id = 'ae000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'an operator cannot delete a business context source directly') from removed;
select throws_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type, created_by)
     values ('a1000000-0000-4000-8000-000000000000', 'Fake', 'business_context', 'a0000000-0000-4000-8000-000000000003') $$,
  '42501', null,
  'clients cannot create business context sources'
);
select lives_ok(
  $$ delete from public.business_context_items where id = 'ae000000-0000-4000-8000-000000000001' $$,
  'an operator can delete an FAQ'
);
reset role;
select is_empty(
  $$ select id from public.knowledge_sources where context_item_id = 'ae000000-0000-4000-8000-000000000001' $$,
  'deleting an entry deletes its source and chunks'
);

-- File sources -------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select lives_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type, storage_bucket, storage_path, created_by)
     values ('a1000000-0000-4000-8000-000000000000', 'Policy.pdf', 'file', 'knowledge',
       'a1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000009/Policy.pdf',
       'a0000000-0000-4000-8000-000000000003') $$,
  'an operator can register a file in the organization''s folder'
);
select throws_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type, storage_bucket, storage_path, created_by)
     values ('a1000000-0000-4000-8000-000000000000', 'Other bucket', 'file', 'avatars',
       'a1000000-0000-4000-8000-000000000000/x/file.pdf', 'a0000000-0000-4000-8000-000000000003') $$,
  '42501', null,
  'files must be in the knowledge bucket'
);
select throws_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type, storage_bucket, storage_path, created_by)
     values ('a1000000-0000-4000-8000-000000000000', 'Their prices', 'file', 'knowledge',
       'b1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000002/Prices.pdf',
       'a0000000-0000-4000-8000-000000000003') $$,
  '23514', null,
  'a source cannot point at another organization''s folder'
);
select throws_ok(
  $$ insert into public.knowledge_sources (organization_id, name, source_type, storage_bucket, storage_path, created_by)
     values ('a1000000-0000-4000-8000-000000000000', 'Traversal', 'file', 'knowledge',
       'a1000000-0000-4000-8000-000000000000/../b1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000002/Prices.pdf',
       'a0000000-0000-4000-8000-000000000003') $$,
  '23514', null,
  'a source path cannot climb out of the organization''s folder'
);

-- Reprocessing ---------------------------------------------------------------------

select is(
  public.reprocess_knowledge_source('a3000000-0000-4000-8000-000000000002'),
  'a1000000-0000-4000-8000-000000000000'::uuid,
  'an operator can reprocess a failed source'
);
select is(
  (select status || '|' || coalesce(error_message, '-') from public.knowledge_sources where id = 'a3000000-0000-4000-8000-000000000002'),
  'pending|-',
  'reprocessing clears the error and queues the source'
);
select throws_ok(
  $$ select public.reprocess_knowledge_source('a3000000-0000-4000-8000-000000000003') $$,
  'P0002', null,
  'a source that is being processed cannot be queued again'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.reprocess_knowledge_source('a3000000-0000-4000-8000-000000000001') $$,
  'P0002', null,
  'a viewer cannot reprocess sources'
);

set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.reprocess_knowledge_source('a3000000-0000-4000-8000-000000000001') $$,
  'P0002', null,
  'another organization''s owner cannot reprocess its sources'
);

-- Storage folders -------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select lives_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('knowledge', 'a1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000009/Policy.pdf') $$,
  'an operator can upload into the organization''s folder'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('knowledge', 'b1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000009/Planted.pdf') $$,
  '42501', null,
  'an operator cannot upload into another organization''s folder'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('knowledge', 'loose-file.pdf') $$,
  '42501', null,
  'files outside an organization folder are refused'
);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'knowledge'),
  2,
  'an operator sees only the organization''s own files'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('knowledge', 'a1000000-0000-4000-8000-000000000000/d0000000-0000-4000-8000-000000000010/Viewer.pdf') $$,
  '42501', null,
  'a viewer cannot upload files'
);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'knowledge'),
  2,
  'a viewer can see (and so download) the organization''s files'
);

set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty(
  $$ select name from storage.objects where bucket_id = 'knowledge' and name like 'a1000000-%' $$,
  'another organization cannot see or download the files'
);
set local storage.allow_delete_query = 'true';
with removed as (delete from storage.objects where bucket_id = 'knowledge' and name like 'a1000000-%' returning 1)
select is(count(*)::int, 0, 'another organization cannot delete the files') from removed;

set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty($$ select name from storage.objects where bucket_id = 'knowledge' $$, 'an outsider sees no files');

-- Retrieval -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';

select is(
  (select array_agg(source_id) from public.search_knowledge('a1000000-0000-4000-8000-000000000000', 'What is the refund policy?')),
  array['a3000000-0000-4000-8000-000000000001'::uuid],
  'keyword search finds the organization''s ready passage (not ones still processing)'
);
select is(
  (select source_name || '|' || source_type || '|' || chunk_index
   from public.search_knowledge('a1000000-0000-4000-8000-000000000000', 'refunds within days')),
  'FAQ|text|0',
  'results carry the source reference needed for a citation'
);
select is_empty(
  $$ select chunk_id from public.search_knowledge('a1000000-0000-4000-8000-000000000000', 'zebra migration patterns') $$,
  'an unrelated question returns nothing (no evidence)'
);
select is_empty(
  $$ select chunk_id from public.search_knowledge('a1000000-0000-4000-8000-000000000000', 'the and of') $$,
  'a stop-word-only question returns nothing without failing'
);
select is(
  (select round(similarity::numeric, 3) from public.search_knowledge(
     'a1000000-0000-4000-8000-000000000000', 'anything',
     array_fill(0.01::real, array[1024])::extensions.vector)),
  1.000,
  'vector search ranks by cosine similarity'
);
select is_empty(
  $$ select chunk_id from public.search_knowledge('b1000000-0000-4000-8000-000000000000', 'refund',
       array_fill(0.01::real, array[1024])::extensions.vector) $$,
  'a member cannot search another organization (keyword or vector)'
);

set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty(
  $$ select chunk_id from public.search_knowledge('a1000000-0000-4000-8000-000000000000', 'refund') $$,
  'an outsider finds nothing'
);

-- The server (service role bypasses RLS) is still held to the organization it asks for.
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
select is(
  (select array_agg(distinct s.organization_id) from public.search_knowledge(
     'b1000000-0000-4000-8000-000000000000', 'refund', array_fill(0.01::real, array[1024])::extensions.vector) as r
   join public.knowledge_sources as s on s.id = r.source_id),
  array['b1000000-0000-4000-8000-000000000000'::uuid],
  'server-side search returns only the requested organization''s passages'
);

-- Processing queue -------------------------------------------------------------------------

select is(
  (select array_agg(s.name order by s.name) from public.claim_knowledge_sources(10, 'a1000000-0000-4000-8000-000000000000') as c
   join public.knowledge_sources as s on s.id = c.source_id),
  array['Goal: Faster replies', 'Handbook.pdf', 'Policy.pdf', 'Template: Refund confirmation'],
  'claiming takes the organization''s pending sources (not ready ones or live leases)'
);
select is(
  (select status || '|' || processing_attempts from public.knowledge_sources where name = 'Policy.pdf'),
  'processing|1',
  'a claimed source is processing, with its attempt counted'
);

reset role;
update public.knowledge_sources set status = 'pending', next_attempt_at = now() + interval '1 hour'
  where id = 'a3000000-0000-4000-8000-000000000002';
set local role service_role;

select ok(
  not exists (select 1 from public.claim_knowledge_sources(10, 'a1000000-0000-4000-8000-000000000000')
              where source_id = 'a3000000-0000-4000-8000-000000000002'),
  'a source waiting for its retry time is not claimed early'
);
select ok(
  not exists (select 1 from public.claim_knowledge_sources(10, 'b1000000-0000-4000-8000-000000000000') as c
              join public.knowledge_sources as s on s.id = c.source_id
              where s.organization_id <> 'b1000000-0000-4000-8000-000000000000'),
  'claiming for one organization never touches another'
);
select is(
  (select status from public.knowledge_sources where id = 'a3000000-0000-4000-8000-000000000003'),
  'processing',
  'a source with a live lease is left alone'
);

reset role;
update public.knowledge_sources set processing_started_at = now() - interval '1 hour', processing_attempts = 1
  where id = 'a3000000-0000-4000-8000-000000000003';
set local role service_role;
select is(
  (select attempt from public.claim_knowledge_sources(10, 'a1000000-0000-4000-8000-000000000000')
   where source_id = 'a3000000-0000-4000-8000-000000000003'),
  2,
  'an expired lease is claimed again as the next attempt'
);

reset role;
update public.knowledge_sources set processing_started_at = now() - interval '1 hour', processing_attempts = 3
  where id = 'a3000000-0000-4000-8000-000000000003';
set local role service_role;
select is_empty(
  $$ select source_id from public.claim_knowledge_sources(10, 'a1000000-0000-4000-8000-000000000000')
     where source_id = 'a3000000-0000-4000-8000-000000000003' $$,
  'a source that keeps dying is not claimed again'
);
select is(
  (select status from public.knowledge_sources where id = 'a3000000-0000-4000-8000-000000000003'),
  'failed',
  '… it is marked failed with an explanation instead'
);

select * from finish();
rollback;

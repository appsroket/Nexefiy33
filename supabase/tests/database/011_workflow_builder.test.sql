-- Workflow builder: graph schema version 2, drafts under the editor's session,
-- activation into immutable versions (admins, after server validation, with
-- optimistic locking), workflow status, runs pinned to a version with inputs
-- checked, the orchestrator's lease, approval gates bound to their content,
-- cancellation, scheduled starts, and who may do each of these.
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
create temp table t_graph (label text primary key, graph jsonb not null);
grant all on t_graph to public;

insert into t_graph values ('valid', '{
  "inputs": [{"key": "email", "label": "Email", "type": "email", "required": true, "description": ""},
             {"key": "count", "label": "Count", "type": "number", "required": false, "description": ""}],
  "nodes": [
    {"id": "trigger", "type": "trigger", "label": "Start", "config": {"kind": "manual", "cron": "", "timezone": ""}},
    {"id": "approve", "type": "approval", "label": "Approve", "config": {"message": "Approve {{inputs.email}}?", "approverRole": "admin", "expiresInHours": 24}},
    {"id": "done", "type": "end", "label": "Done", "config": {"status": "succeeded", "summary": "ok"}}
  ],
  "edges": [{"id": "e1", "source": "trigger", "target": "approve"}, {"id": "e2", "source": "approve", "target": "done", "branch": "approved"}],
  "settings": {"maxRunMinutes": 60, "maxCostUsd": null}
}');

-- Graph schema version 2 ------------------------------------------------------------------

select ok(private.workflow_graph_is_valid(2, (select graph from t_graph where label = 'valid')), 'a well-formed version 2 graph is valid');
select ok(
  private.workflow_graph_is_valid(1, '{"nodes": [{"id": "draft", "type": "employee_task"}], "edges": []}'),
  'version 1 graphs stay valid'
);
select ok(
  not private.workflow_graph_is_valid(2, jsonb_set((select graph from t_graph where label = 'valid'), '{nodes,1,type}', '"trigger"')),
  'a graph has exactly one trigger'
);
select ok(
  not private.workflow_graph_is_valid(2, jsonb_set((select graph from t_graph where label = 'valid'), '{edges,1}',
    '{"id": "e2", "source": "approve", "target": "trigger", "branch": "approved"}')),
  'nothing leads into the trigger'
);
select ok(
  not private.workflow_graph_is_valid(2, '{
    "inputs": [],
    "nodes": [
      {"id": "trigger", "type": "trigger", "label": "Start", "config": {}},
      {"id": "a", "type": "delay", "label": "A", "config": {}},
      {"id": "b", "type": "delay", "label": "B", "config": {}},
      {"id": "done", "type": "end", "label": "Done", "config": {}}
    ],
    "edges": [{"id": "e1", "source": "trigger", "target": "a"}, {"id": "e2", "source": "a", "target": "b"},
              {"id": "e3", "source": "b", "target": "a"}, {"id": "e4", "source": "b", "target": "done"}],
    "settings": {"maxRunMinutes": 60, "maxCostUsd": null}
  }'),
  'cycles are rejected'
);
select ok(
  not private.workflow_graph_is_valid(2, jsonb_set((select graph from t_graph where label = 'valid'), '{edges,0}',
    '{"id": "e1", "source": "done", "target": "approve"}')),
  'nothing follows an end step'
);
select ok(
  not private.workflow_graph_is_valid(2, jsonb_set((select graph from t_graph where label = 'valid'), '{nodes,1,type}', '"script"')),
  'unknown step types are rejected'
);
select ok(
  not private.workflow_graph_is_valid(2, (select graph from t_graph where label = 'valid') - 'settings'),
  'settings are required'
);
select ok(
  not private.workflow_graph_is_valid(2, jsonb_set((select graph from t_graph where label = 'valid'), '{edges,0,target}', '"missing"')),
  'connections must join existing steps'
);

-- Drafts ---------------------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';

with created as (
  insert into public.workflow_definitions (organization_id, name, description, draft_schema_version, draft_graph, draft_layout, draft_source)
  values ('a1000000-0000-4000-8000-000000000000', 'Lead approval', 'Approve leads', 2,
    (select graph from t_graph where label = 'valid'), '{"trigger": {"x": 0, "y": 0}}', 'ai_generated')
  returning id
)
insert into t_ids select 'wf', id from created;
with created as (
  insert into public.workflow_definitions (organization_id, name, draft_schema_version, draft_graph)
  values ('a1000000-0000-4000-8000-000000000000', 'Scratch', 2, '{"nodes": [], "edges": []}')
  returning id
)
insert into t_ids select 'scratch', id from created;

select ok(
  (select w.status = 'draft' and w.current_version_id is null and w.draft_source = 'ai_generated'
   from public.workflow_definitions as w where w.id = (select id from t_ids where label = 'wf')),
  'operators create drafts; a generated workflow starts as a draft'
);
select throws_ok(
  $$ update public.workflow_definitions set status = 'active' where id = (select id from t_ids where label = 'wf') $$,
  '42501', null, 'editors cannot activate a workflow by changing its status'
);
select throws_ok(
  $$ update public.workflow_definitions set current_version_id = 'a5000000-0000-4000-8000-000000000002'
     where id = 'a5000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'editors cannot switch the current version directly'
);
select throws_ok(
  $$ insert into public.workflow_versions (organization_id, workflow_id, graph_schema_version, graph)
     values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'wf'), 2,
       (select graph from t_graph where label = 'valid')) $$,
  '42501', null, 'clients cannot write versions'
);
select throws_ok(
  $$ insert into public.workflow_triggers (organization_id, workflow_id, trigger_type)
     values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'wf'), 'manual') $$,
  '42501', null, 'clients cannot register triggers'
);
select lives_ok(
  $$ update public.workflow_definitions set draft_layout = '{"trigger": {"x": 10, "y": 0}}', draft_validation = '{"valid": true}'
     where id = (select id from t_ids where label = 'wf') $$,
  'operators edit the draft and its layout'
);
select is(
  (select lock_version from public.workflow_definitions where id = (select id from t_ids where label = 'wf')),
  1, 'every edit moves the lock version on (optimistic locking)'
);

delete from public.workflow_definitions where id = 'a5000000-0000-4000-8000-000000000001';
delete from public.workflow_definitions where id = (select id from t_ids where label = 'scratch');
select ok(
  exists (select 1 from public.workflow_definitions where id = 'a5000000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.workflow_definitions where name = 'Scratch'),
  'a workflow that was ever activated can''t be deleted; a never-activated draft can'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
update public.workflow_definitions set description = 'viewer edit' where id = (select id from t_ids where label = 'wf');
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is((select count(*)::int from public.workflow_definitions where name = 'Lead approval'), 0, 'other organizations can''t see the draft');
update public.workflow_definitions set description = 'other org' where name = 'Lead approval';
reset role;
select is(
  (select description from public.workflow_definitions where id = (select id from t_ids where label = 'wf')),
  'Approve leads', 'viewers and other organizations can''t edit drafts'
);

-- Activation ------------------------------------------------------------------------------------

set local role service_role;
select throws_ok(
  $$ select public.publish_workflow_version((select id from t_ids where label = 'wf'), 'a0000000-0000-4000-8000-000000000003', 1,
       'Lead approval', (select graph from t_graph where label = 'valid'), '{}', '{}') $$,
  'P0002', null, 'operators can''t activate (admins only)'
);
select throws_ok(
  $$ select public.publish_workflow_version((select id from t_ids where label = 'wf'), 'b0000000-0000-4000-8000-000000000001', 1,
       'Lead approval', (select graph from t_graph where label = 'valid'), '{}', '{}') $$,
  'P0002', null, 'another organization''s owner can''t activate it'
);
select throws_ok(
  $$ select public.publish_workflow_version((select id from t_ids where label = 'wf'), 'a0000000-0000-4000-8000-000000000002', 0,
       'Lead approval', (select graph from t_graph where label = 'valid'), '{}', '{}') $$,
  '40001', null, 'a draft changed since it was validated can''t be activated'
);
select throws_ok(
  $$ select public.publish_workflow_version((select id from t_ids where label = 'wf'), 'a0000000-0000-4000-8000-000000000002', 1,
       'Lead', (select graph from t_graph where label = 'valid'), '{}', '{}') $$,
  '22023', null, 'activation is confirmed by typing the workflow''s name'
);
select throws_ok(
  $$ select public.publish_workflow_version((select id from t_ids where label = 'wf'), 'a0000000-0000-4000-8000-000000000002', 1,
       'Lead approval', jsonb_set((select graph from t_graph where label = 'valid'), '{edges,1,source}', '"done"'), '{}', '{}') $$,
  '23514', null, 'an invalid graph is refused by the version constraint'
);

insert into t_ids select 'v1', (public.publish_workflow_version((select id from t_ids where label = 'wf'),
  'a0000000-0000-4000-8000-000000000002', 1, 'lead approval', (select graph from t_graph where label = 'valid'),
  '{"trigger": {"x": 0, "y": 0}}', '{"valid": true}',
  jsonb_build_object('cron', '0 9 * * 1-5', 'timezone', 'UTC', 'next_run_at', now() + interval '1 day')) ->> 'version_id')::uuid;

select ok(
  (select w.status = 'active' and w.current_version_id = (select id from t_ids where label = 'v1')
     and w.activated_by = 'a0000000-0000-4000-8000-000000000002'
   from public.workflow_definitions as w where w.id = (select id from t_ids where label = 'wf')),
  'activation makes the new version current'
);
select ok(
  (select v.version = 1 and v.graph_schema_version = 2 and v.source = 'ai_generated' and v.published_by = 'a0000000-0000-4000-8000-000000000002'
     and v.graph_sha256 = private.sha256_hex(v.graph::text) and v.layout ? 'trigger'
   from public.workflow_versions as v where v.id = (select id from t_ids where label = 'v1')),
  'the version records its graph, fingerprint, layout, source and who activated it'
);
select ok(
  exists (select 1 from public.workflow_triggers where workflow_version_id = (select id from t_ids where label = 'v1')
    and trigger_type = 'schedule' and enabled and cron_expression = '0 9 * * 1-5'),
  'a scheduled trigger is registered for the version'
);
select ok(
  exists (select 1 from public.audit_logs where action = 'workflow.activated' and target_id = (select id::text from t_ids where label = 'v1')),
  'activation is audited'
);
reset role;
select throws_ok(
  $$ update public.workflow_versions set graph = graph where id = (select id from t_ids where label = 'v1') $$,
  '42501', null, 'versions are immutable'
);

set local role service_role;
insert into t_ids select 'v2', (public.publish_workflow_version((select id from t_ids where label = 'wf'),
  'a0000000-0000-4000-8000-000000000001', 2, 'Lead approval', (select graph from t_graph where label = 'valid'), '{}', '{}') ->> 'version_id')::uuid;
select ok(
  (select v.version = 2 from public.workflow_versions as v where v.id = (select id from t_ids where label = 'v2'))
  and not exists (select 1 from public.workflow_triggers where workflow_id = (select id from t_ids where label = 'wf') and enabled),
  'a second activation creates version 2 and retires the old schedule'
);
reset role;

-- Status -----------------------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.change_workflow_status((select id from t_ids where label = 'wf'), 'pause'), 'paused', 'operators pause a workflow');
select throws_ok(
  $$ select public.start_workflow_run((select id from t_ids where label = 'wf'), '{"email": "a@example.com"}', 'run-key-paused') $$,
  '55000', null, 'a paused workflow can''t run'
);
select throws_ok(
  $$ select public.change_workflow_status((select id from t_ids where label = 'wf'), 'resume') $$,
  'P0002', null, 'only admins resume'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(public.change_workflow_status((select id from t_ids where label = 'wf'), 'resume'), 'active', 'admins resume it');

-- Runs ---------------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.start_workflow_run((select id from t_ids where label = 'wf'), '{}', 'run-key-0001') $$,
  '22023', null, 'required inputs must be given'
);
select throws_ok(
  $$ select public.start_workflow_run((select id from t_ids where label = 'wf'), '{"email": "a@example.com", "other": 1}', 'run-key-0001') $$,
  '22023', null, 'unknown inputs are refused'
);
select throws_ok(
  $$ select public.start_workflow_run((select id from t_ids where label = 'wf'), '{"email": "a@example.com", "count": "three"}', 'run-key-0001') $$,
  '22023', null, 'inputs must have their declared type'
);
select throws_ok(
  $$ select public.start_workflow_run((select id from t_ids where label = 'wf'), '{"email": "not-an-email"}', 'run-key-0001') $$,
  '22023', null, 'email inputs must look like an address'
);
insert into t_ids select 'run', public.start_workflow_run((select id from t_ids where label = 'wf'), '{"email": "a@example.com", "count": 3}', 'run-key-0001');
select is(
  public.start_workflow_run((select id from t_ids where label = 'wf'), '{"email": "a@example.com", "count": 3}', 'run-key-0001'),
  (select id from t_ids where label = 'run'), 'starting again with the same key returns the same run'
);
select ok(
  (select r.status = 'queued' and r.workflow_version_id = (select id from t_ids where label = 'v2')
     and r.authorized_by = 'a0000000-0000-4000-8000-000000000001' and r.created_by = 'a0000000-0000-4000-8000-000000000003'
     and r.advance_requested_at is not null and r.deadline_at <= now() + interval '60 minutes'
   from public.workflow_runs as r where r.id = (select id from t_ids where label = 'run')),
  'the run pins the current version, its activator''s authority and the version''s time limit'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select public.start_workflow_run((select id from t_ids where label = 'wf'), '{"email": "a@example.com"}', 'run-key-0002') $$,
  'P0002', null, 'viewers can''t start runs'
);
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select public.start_workflow_run((select id from t_ids where label = 'wf'), '{"email": "a@example.com"}', 'run-key-0003') $$,
  'P0002', null, 'other organizations can''t start runs'
);
reset role;

-- The orchestrator's lease ----------------------------------------------------------------------------

set local role service_role;
create temp table t_claim as select * from public.claim_workflow_runs(5, 60, (select id from t_ids where label = 'run'));
select is((select count(*)::int from t_claim), 1, 'the orchestrator claims the run');
select is(
  (select count(*)::int from public.claim_workflow_runs(5, 60, (select id from t_ids where label = 'run'))),
  0, 'a leased run isn''t claimed twice'
);
select ok(
  not public.record_workflow_progress((select id from t_ids where label = 'run'), gen_random_uuid(), '[]', '[]', 'running'),
  'progress without the lease is refused'
);
select ok(
  public.record_workflow_progress((select id from t_ids where label = 'run'), (select lease_token from t_claim),
    '[{"node_id": "trigger", "node_type": "trigger", "label": "Start", "status": "succeeded", "output": {"email": "a@example.com"}},
      {"node_id": "approve", "node_type": "approval", "label": "Approve", "status": "waiting"}]',
    '[{"event_type": "step.started", "message": "Started."}]', 'waiting', null, null, false),
  'the lease holder records steps'
);
select ok(
  public.record_workflow_progress((select id from t_ids where label = 'run'), (select lease_token from t_claim),
    '[{"node_id": "trigger", "node_type": "trigger", "label": "Start", "status": "failed", "error": {"code": "x"}}]', '[]', 'waiting'),
  'and releases the lease'
);
select ok(
  (select s.status = 'succeeded' from public.workflow_run_steps as s where s.run_id = (select id from t_ids where label = 'run') and s.node_id = 'trigger'),
  'a finished step never changes'
);
select ok(
  (select r.status = 'waiting' and r.lease_token is null from public.workflow_runs as r where r.id = (select id from t_ids where label = 'run'))
  and exists (select 1 from public.execution_events where workflow_run_id = (select id from t_ids where label = 'run') and event_type = 'step.started'),
  'the run waits, unleased, with its events'
);
select is(
  (select count(*)::int from public.claim_workflow_runs(5, 60, (select id from t_ids where label = 'run'))),
  0, 'a waiting run with nothing changed isn''t claimed'
);
reset role;

-- Approval gates ------------------------------------------------------------------------------------------

set local role service_role;
insert into public.tasks (organization_id, workflow_run_id, node_id, title, source, status, idempotency_key, started_at)
values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'run'), 'approve', 'Approval: Approve',
  'workflow', 'waiting_approval', 'workflow:gate-1', now());
insert into t_ids select 'gate_task', id from public.tasks where idempotency_key = 'workflow:gate-1';
select throws_ok(
  $$ insert into public.approval_requests (organization_id, kind, task_id, workflow_run_id, workflow_version_id, action_summary,
       proposed_action, payload_sha256, required_role, expires_at)
     values ('a1000000-0000-4000-8000-000000000000', 'workflow_gate', 'a7000000-0000-4000-8000-000000000001',
       'a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'Approve?',
       '{"message": "Approve?"}', repeat('0', 64), 'admin', now() + interval '1 day') $$,
  '23514', null, 'a gate must belong to a waiting approval step of its run (not an employee''s task)'
);
insert into public.approval_requests (organization_id, kind, task_id, workflow_run_id, workflow_version_id, action_summary,
  proposed_action, payload_sha256, required_role, expires_at)
values ('a1000000-0000-4000-8000-000000000000', 'workflow_gate', (select id from t_ids where label = 'gate_task'),
  (select id from t_ids where label = 'run'), (select id from t_ids where label = 'v2'), 'Approve a@example.com?',
  '{"message": "Approve a@example.com?"}', repeat('0', 64), 'admin', now() + interval '1 day');
insert into t_ids select 'gate', id from public.approval_requests where task_id = (select id from t_ids where label = 'gate_task');
select is(
  (select payload_sha256 from public.approval_requests where id = (select id from t_ids where label = 'gate')),
  private.sha256_hex('{"message": "Approve a@example.com?"}'::jsonb::text),
  'the database fingerprints a gate from exactly what the approver sees'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ select public.decide_approval((select id from t_ids where label = 'gate'), 'approved',
       (select payload_sha256 from public.approval_requests where id = (select id from t_ids where label = 'gate'))) $$,
  'P0002', null, 'a gate needs the role it asks for'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select throws_ok(
  $$ select public.decide_approval((select id from t_ids where label = 'gate'), 'approved', repeat('1', 64)) $$,
  '40001', null, 'a gate decision must confirm the content the approver saw'
);
select is(
  (public.decide_approval((select id from t_ids where label = 'gate'), 'approved',
    (select payload_sha256 from public.approval_requests where id = (select id from t_ids where label = 'gate')), 'Looks right.')).status,
  'approved', 'admins decide the gate'
);
reset role;
select ok(
  (select t.status = 'succeeded' and t.result ->> 'decision' = 'approved' and t.result ->> 'note' = 'Looks right.'
   from public.tasks as t where t.id = (select id from t_ids where label = 'gate_task')),
  'an approved gate completes its step''s task'
);
select ok(
  (select r.advance_requested_at is not null from public.workflow_runs as r where r.id = (select id from t_ids where label = 'run')),
  'and wakes the run'
);

-- A rejected gate and an expired gate fail their step (the run follows its rejected path).
set local role service_role;
insert into public.tasks (organization_id, workflow_run_id, node_id, title, source, status, idempotency_key, started_at)
values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'run'), 'approve2', 'Approval 2',
  'workflow', 'waiting_approval', 'workflow:gate-2', now()),
  ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'run'), 'approve3', 'Approval 3',
  'workflow', 'waiting_approval', 'workflow:gate-3', now());
insert into public.approval_requests (organization_id, kind, task_id, workflow_run_id, workflow_version_id, action_summary,
  proposed_action, payload_sha256, required_role, expires_at)
select 'a1000000-0000-4000-8000-000000000000', 'workflow_gate', t.id, t.workflow_run_id, (select id from t_ids where label = 'v2'),
  t.title, jsonb_build_object('message', t.title), repeat('0', 64), 'operator',
  now() + interval '1 day'
from public.tasks as t where t.idempotency_key in ('workflow:gate-2', 'workflow:gate-3');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  (public.decide_approval((select a.id from public.approval_requests as a join public.tasks as t on t.id = a.task_id where t.node_id = 'approve2'),
    'rejected', (select a.payload_sha256 from public.approval_requests as a join public.tasks as t on t.id = a.task_id where t.node_id = 'approve2'))).status,
  'rejected', 'operators decide gates that ask for operators'
);
reset role;
select ok(
  (select t.status = 'failed' and t.error ->> 'code' = 'approval_rejected' from public.tasks as t where t.node_id = 'approve2'),
  'a rejected gate fails its step''s task'
);
alter table public.approval_requests disable trigger guard_approval_request;
update public.approval_requests set created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
where task_id = (select id from public.tasks where node_id = 'approve3');
alter table public.approval_requests enable trigger guard_approval_request;
set local role service_role;
select ok(public.expire_overdue_approvals(10) >= 1, 'overdue gates expire');
reset role;
select ok(
  (select t.status = 'failed' and t.error ->> 'code' = 'approval_expired' from public.tasks as t where t.node_id = 'approve3'),
  'an expired gate fails its step''s task'
);

-- Leases expire; the old holder is superseded ---------------------------------------------------------------

set local role service_role;
create temp table t_claim2 as select * from public.claim_workflow_runs(5, 60, (select id from t_ids where label = 'run'));
select is((select count(*)::int from t_claim2), 1, 'a woken run is claimed again');
reset role;
update public.workflow_runs set lease_expires_at = now() - interval '1 second' where id = (select id from t_ids where label = 'run');
set local role service_role;
create temp table t_claim3 as select * from public.claim_workflow_runs(5, 60, (select id from t_ids where label = 'run'));
select is((select count(*)::int from t_claim3), 1, 'a run whose orchestrator stopped is recovered');
select ok(
  not public.record_workflow_progress((select id from t_ids where label = 'run'), (select lease_token from t_claim2), '[]', '[]', 'running'),
  'the superseded orchestrator can''t write'
);
select ok(
  public.record_workflow_progress((select id from t_ids where label = 'run'), (select lease_token from t_claim3), '[]', '[]', 'waiting'),
  'the new one can'
);
reset role;

-- Cancelling -----------------------------------------------------------------------------------------------------

set local role service_role;
insert into public.tasks (organization_id, workflow_run_id, node_id, employee_id, employee_version_id, title, source, status, idempotency_key)
values ('a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'run'), 'work', 'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000002', 'Employee step', 'workflow', 'queued', 'workflow:work-1');
insert into public.workflow_run_steps (organization_id, run_id, node_id, node_type, status, task_id)
select 'a1000000-0000-4000-8000-000000000000', (select id from t_ids where label = 'run'), 'work', 'employee_task', 'running', id
from public.tasks where idempotency_key = 'workflow:work-1';
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok($$ select public.cancel_workflow_run((select id from t_ids where label = 'run')) $$, 'P0002', null, 'viewers can''t cancel runs');
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(public.cancel_workflow_run((select id from t_ids where label = 'run')), 'cancelled', 'operators cancel a run');
select throws_ok($$ select public.cancel_workflow_run((select id from t_ids where label = 'run')) $$, '55000', null, 'a finished run can''t be cancelled again');
reset role;
select ok(
  (select r.status = 'cancelled' and r.finished_at is not null and r.lease_token is null from public.workflow_runs as r where r.id = (select id from t_ids where label = 'run'))
  and (select s.status = 'cancelled' from public.workflow_run_steps as s where s.run_id = (select id from t_ids where label = 'run') and s.node_id = 'work')
  and (select t.status = 'cancelled' from public.tasks as t where t.idempotency_key = 'workflow:work-1'),
  'cancelling ends the run, its unfinished steps and the work not yet started'
);
set local role service_role;
select ok(
  not public.record_workflow_progress((select id from t_ids where label = 'run'), (select lease_token from t_claim3), '[]', '[]', 'running'),
  'nothing can be recorded on a cancelled run'
);
reset role;

-- Scheduled starts -------------------------------------------------------------------------------------------------

set local role service_role;
insert into t_ids select 'v3', (public.publish_workflow_version((select id from t_ids where label = 'wf'),
  'a0000000-0000-4000-8000-000000000001', (select lock_version from public.workflow_definitions where id = (select id from t_ids where label = 'wf')),
  'Lead approval', jsonb_set((select graph from t_graph where label = 'valid'), '{inputs}', '[]'), '{}', '{}',
  jsonb_build_object('cron', '0 * * * *', 'timezone', 'UTC', 'next_run_at', now() + interval '1 hour')) ->> 'version_id')::uuid;
reset role;
update public.workflow_triggers set next_run_at = now() - interval '1 minute' where workflow_version_id = (select id from t_ids where label = 'v3');
set local role service_role;
insert into t_ids select 'scheduled', public.start_scheduled_workflow_run(
  (select id from public.workflow_triggers where workflow_version_id = (select id from t_ids where label = 'v3')),
  now() - interval '1 minute', now() + interval '59 minutes');
select ok(
  (select r.trigger_type = 'schedule' and r.workflow_version_id = (select id from t_ids where label = 'v3') and r.input = '{}'::jsonb
   from public.workflow_runs as r where r.id = (select id from t_ids where label = 'scheduled')),
  'a due schedule starts a run of the version that registered it'
);
select ok(
  public.start_scheduled_workflow_run(
    (select id from public.workflow_triggers where workflow_version_id = (select id from t_ids where label = 'v3')),
    now() - interval '1 minute', now() + interval '59 minutes') is null
  and (select next_run_at = now() + interval '59 minutes' from public.workflow_triggers where workflow_version_id = (select id from t_ids where label = 'v3')),
  'the schedule moves on, so the same slot never starts twice'
);
reset role;

-- Isolation and privileges --------------------------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  (select count(*)::int from public.workflow_run_steps where organization_id = 'a1000000-0000-4000-8000-000000000000'),
  0, 'other organizations can''t see run steps'
);
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select ok((select count(*) from public.workflow_run_steps) > 0, 'members (viewers included) read their run steps');
reset role;

select ok(
  not has_function_privilege('authenticated', 'public.publish_workflow_version(uuid, uuid, integer, text, jsonb, jsonb, jsonb, jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_workflow_runs(integer, integer, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.record_workflow_progress(uuid, uuid, jsonb, jsonb, text, timestamptz, jsonb, boolean, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.start_scheduled_workflow_run(uuid, timestamptz, timestamptz)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.start_workflow_run(uuid, jsonb, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.publish_workflow_version(uuid, uuid, integer, text, jsonb, jsonb, jsonb, jsonb)', 'EXECUTE'),
  'only the server activates versions and advances runs; signed-in users start, cancel and pause through the functions'
);

select * from finish();
rollback;

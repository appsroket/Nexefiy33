-- Analytics, called directly as each role (as PostgREST would): outcome
-- records captured from succeeded AI actions (with links to the action and
-- task, once per action, never for a person's own action); every metric
-- calculation against a hand-counted data set; the evidence rows behind each
-- number; membership and admin checks; and isolation between organizations.
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

-- ===========================================================================
-- Data set (organization A, as the database owner)
-- ===========================================================================
-- Employees: a2..01 "Support Agent" (fixture; its version has no department →
-- 'unspecified') and a2..0e "Sales Rep" (department 'sales').
-- In the period (the last day):
--   e1 sales     succeeded, verified, 1 attempt; upsert created contact 501 as
--                SQL, then a Slack message 30 min after creation
--   e2 sales     succeeded, needs review; attempt 1 failed, attempt 2
--                succeeded (recovered); one approval approved by the owner
--   e3 support   failed (permanent/provider_error), 2 failed attempts; a
--                Slack post failed (rate_limited)
--   e4 support   cancelled by the operator (audit entry)
--   e5 sales     handed off and completed by a person
--   p1           a person's own action task (no employee): its upsert proves nothing
--   fixture task a7..01 (support, workflow run, waiting for approval: open)
-- Outside the period: e6 sales, created three days ago.

insert into public.ai_employees (id, organization_id, name, role_category)
values ('a2000000-0000-4000-8000-00000000000e', 'a1000000-0000-4000-8000-000000000000', 'Sales Rep', 'sales');
insert into public.employee_versions (id, organization_id, employee_id, instructions, config_schema_version, config)
values ('a2000000-0000-4000-8000-00000000000f', 'a1000000-0000-4000-8000-000000000000',
  'a2000000-0000-4000-8000-00000000000e', 'Qualify leads.', 2, $json${
  "profile": { "name": "Sales Rep", "department": "sales", "description": "Qualifies leads." },
  "responsibilities": ["Qualify inbound leads"],
  "skills": [],
  "tools": [{ "toolKey": "hubspot.contacts.upsert", "integrationId": null, "approval": "require_approval" }],
  "knowledge": { "access": "all", "sourceIds": [], "maxPassages": 5 },
  "model": { "provider": "anthropic", "tier": "balanced", "effort": "medium", "maxOutputTokens": 8000 },
  "successCriteria": ["Every lead has a stage"],
  "allowedActions": [],
  "prohibitedActions": [],
  "escalation": { "when": [], "behavior": "stop_and_report", "notes": "" },
  "limits": { "maxTurnsPerTask": 8, "maxToolCallsPerTask": 10, "maxCostUsdPerTask": 1, "maxRuntimeSeconds": 120 },
  "budget": { "monthlyUsd": 50 }
}$json$);
update public.ai_employees set current_version_id = 'a2000000-0000-4000-8000-00000000000f', status = 'active',
  active_version_id = 'a2000000-0000-4000-8000-00000000000f', activated_at = now()
where id = 'a2000000-0000-4000-8000-00000000000e';

insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    created_at, started_at, completed_at, attempt_count, result, error, handed_off_at, handed_off_by)
values
  ('a7000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-00000000000e',
    'a2000000-0000-4000-8000-00000000000f', 'Qualify Dana', 'manual', 'succeeded', 'an-e1',
    now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour', 1,
    '{"verification": {"status": "verified", "checks": []}}', null, null, null),
  ('a7000000-0000-4000-8000-0000000000e2', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-00000000000e',
    'a2000000-0000-4000-8000-00000000000f', 'Update Lee', 'manual', 'succeeded', 'an-e2',
    now() - interval '5 hours', now() - interval '5 hours', now() - interval '1 hour', 2,
    '{"verification": {"status": "needs_review", "checks": []}}', null, null, null),
  ('a7000000-0000-4000-8000-0000000000e3', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Notify the team', 'manual', 'failed', 'an-e3',
    now() - interval '4 hours', now() - interval '4 hours', now() - interval '3 hours', 2,
    null, '{"code": "provider_error", "class": "permanent", "message": "Slack refused."}', null, null),
  ('a7000000-0000-4000-8000-0000000000e4', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002', 'Answer a question', 'manual', 'cancelled', 'an-e4',
    now() - interval '6 hours', null, now() - interval '5 hours', 0, null, null, null, null),
  ('a7000000-0000-4000-8000-0000000000e5', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-00000000000e',
    'a2000000-0000-4000-8000-00000000000f', 'Call back Sam', 'manual', 'succeeded', 'an-e5',
    now() - interval '7 hours', now() - interval '7 hours', now() - interval '2 hours', 1,
    '{"handoff": {"outcome": "done"}}', null, now() - interval '6 hours', 'a0000000-0000-4000-8000-000000000003'),
  ('a7000000-0000-4000-8000-0000000000e6', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-00000000000e',
    'a2000000-0000-4000-8000-00000000000f', 'Old work', 'manual', 'succeeded', 'an-e6',
    now() - interval '3 days', now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 1,
    '{"verification": {"status": "verified", "checks": []}}', null, null, null),
  ('a7000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-000000000000', null, null,
    'Person’s own update', 'manual', 'succeeded', 'an-p1',
    now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours', 0, null, null, null, null);

insert into public.task_attempts (organization_id, task_id, attempt_number, status, started_at, finished_at, active_ms,
    model_input_tokens, model_output_tokens, cost_micros, error)
values
  ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e1', 1, 'succeeded',
    now() - interval '2 hours', now() - interval '1 hour', 2000, 100, 50, 1000, null),
  ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e2', 1, 'failed',
    now() - interval '5 hours', now() - interval '4 hours', 1000, 40, 10, 300, '{"code": "model_unavailable", "class": "transient"}'),
  ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e2', 2, 'succeeded',
    now() - interval '4 hours', now() - interval '1 hour', 3000, 60, 20, 700, null),
  ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e3', 1, 'failed',
    now() - interval '4 hours', now() - interval '4 hours', 500, 10, 5, 100, '{"code": "provider_error", "class": "transient"}'),
  ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e3', 2, 'failed',
    now() - interval '4 hours', now() - interval '3 hours', 500, 10, 5, 100, '{"code": "provider_error", "class": "permanent"}'),
  ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e5', 1, 'succeeded',
    now() - interval '7 hours', now() - interval '6 hours', 4000, 20, 10, 200, null),
  ('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e6', 1, 'succeeded',
    now() - interval '3 days', now() - interval '3 days', 9000, 900, 900, 9000, null);

insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    action_category, risk_tier, input_redacted, input_sha256, output_redacted, status, policy_decision, idempotency_key,
    error, created_at, started_at, finished_at)
values
  ('a8000000-0000-4000-8000-0000000000e1', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e1',
    'a2000000-0000-4000-8000-00000000000e', 'a4000000-0000-4000-8000-000000000001', 'hubspot.contacts.upsert',
    'write_external', 'record_change', 'medium',
    '{"email": "dana@example.test", "lifecycleStage": "salesqualifiedlead"}', repeat('e', 64),
    '{"id": "501", "result": "created", "email": "dana@example.test", "url": null}', 'succeeded', 'allow', 'an-x1', null,
    now() - interval '110 minutes', now() - interval '110 minutes', now() - interval '100 minutes'),
  ('a8000000-0000-4000-8000-0000000000e2', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e1',
    'a2000000-0000-4000-8000-00000000000e', 'a4000000-0000-4000-8000-000000000001', 'slack.messages.post',
    'write_external', 'external_message', 'high', '{"channel": "C1", "textLength": 20}', repeat('e', 64),
    '{"channel": "C1", "ts": "1.2", "threadTs": null}', 'succeeded', 'allow', 'an-x2', null,
    now() - interval '95 minutes', now() - interval '95 minutes', now() - interval '90 minutes'),
  ('a8000000-0000-4000-8000-0000000000e3', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e3',
    'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'slack.messages.post',
    'write_external', 'external_message', 'high', '{"channel": "C2", "textLength": 20}', repeat('e', 64),
    null, 'failed', 'allow', 'an-x3', '{"code": "rate_limited", "message": "Slow down."}',
    now() - interval '230 minutes', now() - interval '230 minutes', now() - interval '229 minutes'),
  ('a8000000-0000-4000-8000-0000000000e4', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000e2',
    'a2000000-0000-4000-8000-00000000000e', 'a4000000-0000-4000-8000-000000000001', 'hubspot.notes.create',
    'write_external', 'record_change', 'medium', '{"contactId": "777", "bodyLength": 12}', repeat('e', 64),
    null, 'awaiting_approval', 'require_approval', 'an-x4', null,
    now() - interval '3 hours', null, null),
  ('a8000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-0000000000f1',
    null, 'a4000000-0000-4000-8000-000000000001', 'hubspot.contacts.upsert', 'write_external', 'record_change', 'medium',
    '{"email": "own@example.test", "lifecycleStage": "salesqualifiedlead"}', repeat('e', 64),
    '{"id": "900", "result": "created", "email": "own@example.test", "url": null}', 'succeeded', 'allow', 'an-xp', null,
    now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours');

insert into public.approval_requests (id, organization_id, tool_execution_id, task_id, employee_id, action_summary,
    proposed_action, payload_sha256, expires_at)
values ('a9000000-0000-4000-8000-0000000000e4', 'a1000000-0000-4000-8000-000000000000', 'a8000000-0000-4000-8000-0000000000e4',
  'a7000000-0000-4000-8000-0000000000e2', 'a2000000-0000-4000-8000-00000000000e', 'Add a note',
  '{"action": "hubspot.notes.create"}', repeat('e', 64), now() + interval '1 day');
-- Approved by the signed-in owner (the only way an approval is decided).
set local role authenticated;
set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select status from public.decide_approval('a9000000-0000-4000-8000-0000000000e4', 'approved', repeat('e', 64));
reset role;

-- The approved note finishes later: the update path records its outcome too.
update public.tool_executions
set status = 'succeeded', started_at = now() - interval '85 minutes', finished_at = now() - interval '80 minutes', output_redacted = '{"id": "n1", "contactId": "777", "url": null}'
where id = 'a8000000-0000-4000-8000-0000000000e4';
-- Touching a succeeded action again records nothing more.
update public.tool_executions set status = 'succeeded' where id = 'a8000000-0000-4000-8000-0000000000e4';

insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id) values
  ('a1000000-0000-4000-8000-000000000000', 'user', 'a0000000-0000-4000-8000-000000000003', 'task.cancelled', 'tasks',
    'a7000000-0000-4000-8000-0000000000e4'),
  ('a1000000-0000-4000-8000-000000000000', 'user', 'a0000000-0000-4000-8000-000000000003', 'task.priority_changed', 'tasks',
    'a7000000-0000-4000-8000-0000000000e1');

-- Organization B (besides its fixture task): one succeeded, verified task with a qualifying upsert.
insert into public.tasks (id, organization_id, employee_id, employee_version_id, title, source, status, idempotency_key,
    created_at, started_at, completed_at, attempt_count, result)
values ('b7000000-0000-4000-8000-0000000000e1', 'b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000002', 'B work', 'manual', 'succeeded', 'bn-e1', now() - interval '1 hour',
  now() - interval '1 hour', now() - interval '30 minutes', 1, '{"verification": {"status": "verified", "checks": []}}');
insert into public.tool_executions (id, organization_id, task_id, employee_id, integration_id, tool_key, risk_level,
    input_redacted, input_sha256, output_redacted, status, policy_decision, idempotency_key, finished_at)
values ('b8000000-0000-4000-8000-0000000000e1', 'b1000000-0000-4000-8000-000000000000', 'b7000000-0000-4000-8000-0000000000e1',
  'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'hubspot.contacts.upsert', 'write_external',
  '{"email": "b@example.test", "lifecycleStage": "marketingqualifiedlead"}', repeat('b', 64),
  '{"id": "B1", "result": "updated", "email": "b@example.test", "url": null}', 'succeeded', 'allow', 'bn-x1', now());

-- ===========================================================================
-- Outcome records from actions
-- ===========================================================================

select bag_eq(
  $$ select outcome_key, subject, tool_execution_id::text, task_id::text, employee_id::text
     from public.outcome_records where organization_id = 'a1000000-0000-4000-8000-000000000000' and tool_execution_id is not null $$,
  $$ values
    ('crm.contact_created', '501', 'a8000000-0000-4000-8000-0000000000e1', 'a7000000-0000-4000-8000-0000000000e1', 'a2000000-0000-4000-8000-00000000000e'),
    ('crm.lead_qualified', '501', 'a8000000-0000-4000-8000-0000000000e1', 'a7000000-0000-4000-8000-0000000000e1', 'a2000000-0000-4000-8000-00000000000e'),
    ('messaging.message_sent', 'C1', 'a8000000-0000-4000-8000-0000000000e2', 'a7000000-0000-4000-8000-0000000000e1', 'a2000000-0000-4000-8000-00000000000e'),
    ('crm.note_logged', '777', 'a8000000-0000-4000-8000-0000000000e4', 'a7000000-0000-4000-8000-0000000000e2', 'a2000000-0000-4000-8000-00000000000e') $$,
  'succeeded AI actions record the outcomes they prove, once each, linked to the action and task (not a failed action, not a person’s own)'
);
select is(
  (select metadata from public.outcome_records where tool_execution_id = 'a8000000-0000-4000-8000-0000000000e1'
     and outcome_key = 'crm.lead_qualified'),
  '{"tool_key": "hubspot.contacts.upsert", "stage": "salesqualifiedlead"}'::jsonb,
  'an outcome stores the action and stage, not the contact’s email'
);
select is(
  (select outcome_key || ':' || subject from public.outcome_records where organization_id = 'b1000000-0000-4000-8000-000000000000'
     and tool_execution_id is not null),
  'crm.lead_qualified:B1',
  'an update that marks a lead qualified is a qualified lead, not a created contact'
);

-- Retention clears payloads, never outcomes.
update public.tool_executions set input_redacted = '{}', output_redacted = null, payload_purged_at = now()
where id = 'a8000000-0000-4000-8000-0000000000e1';
select is(
  (select count(*)::int from public.outcome_records where tool_execution_id = 'a8000000-0000-4000-8000-0000000000e1'),
  2, 'outcomes survive the purge of the action’s payload'
);

-- ===========================================================================
-- Access
-- ===========================================================================

set local role authenticated;
set local request.jwt.claims = '{"sub": "c0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select * from public.analytics_task_metrics('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour') $$,
  '42501', null, 'an outsider reads no analytics'
);
select throws_ok(
  $$ select * from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'created') $$,
  '42501', null, 'an outsider reads no evidence'
);

set local request.jwt.claims = '{"sub": "b0000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ select * from public.analytics_outcome_metrics('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour') $$,
  '42501', null, 'another workspace’s owner reads none of A’s analytics'
);
select is(
  (select tasks_created from public.analytics_task_metrics('b1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour')
   where grain = 'organization'),
  2::bigint, 'B’s owner sees only B’s tasks (its fixture task and the one above)'
);
select is(
  (select count(*)::int from public.analytics_evidence('b1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'created')
   where item ->> 'task_id' like 'a%'),
  0, 'B’s evidence never lists A’s rows'
);

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$ select * from public.analytics_task_metrics('a1000000-0000-4000-8000-000000000000', now(), now() - interval '1 day') $$,
  '22023', null, 'a period must end after it starts'
);
select throws_ok(
  $$ select * from public.analytics_task_metrics('a1000000-0000-4000-8000-000000000000', now() - interval '400 days', now()) $$,
  '22023', null, 'a period spans at most 366 days'
);
select throws_ok(
  $$ select * from public.analytics_model_usage('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour') $$,
  '42501', null, 'a viewer can’t read model usage (admins only, like usage records)'
);
select throws_ok(
  $$ select * from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'tasks; drop table x', 'created') $$,
  '22023', null, 'evidence sources are a fixed list'
);
select throws_ok(
  $$ select * from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'created', 'employee', null) $$,
  '22023', null, 'a scope other than the organization needs a key'
);
select throws_ok(
  $$ select * from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'created', 'organization', null, 500) $$,
  '22023', null, 'evidence pages hold at most 200 rows'
);

-- ===========================================================================
-- Task metrics (a viewer sees the same numbers as an admin)
-- ===========================================================================

create temp table t_metrics as
select * from public.analytics_task_metrics('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour');

select is(
  (select row(tasks_created, tasks_open, tasks_finished, tasks_completed, tasks_verified, tasks_needs_review, tasks_failed,
     tasks_cancelled, tasks_skipped, tasks_completed_by_person)::text from t_metrics where grain = 'organization'),
  '(6,1,5,2,1,1,1,1,0,1)',
  'organization: 6 employee tasks created (not the person’s task or the old one); 1 open, 5 finished, 2 completed by employees (1 verified), 1 failed, 1 cancelled, 1 completed by a person'
);
select is(
  (select row(tasks_retried, retries, recovery_attempted, tasks_recovered)::text from t_metrics where grain = 'organization'),
  '(2,2,2,1)',
  'retries and recovery: two tasks retried once each; one of the two recovered'
);
select is(
  (select row(approvals_requested, approvals_approved, approvals_rejected, approvals_expired, tasks_intervened, person_controls, tasks_handoff)::text
   from t_metrics where grain = 'organization'),
  '(2,1,0,0,3,1,1)',
  'people: 2 approvals asked (fixture + e2), 1 approved; 3 tasks needed a person (approval, cancel, handoff); a priority change is not an intervention'
);
select is(
  (select row(tasks_responded, response_p50_ms, duration_p50_ms, duration_p90_ms, active_p50_ms, active_ms)::text
   from t_metrics where grain = 'organization'),
  '(1,1800000,9000000,13320000,3000,11000)',
  'durations: first message 30 min after creation; completed by employees in 1 h and 4 h (median 2.5 h, p90 3.7 h); active 2 s and 4 s'
);
select is(
  (select row(input_tokens, output_tokens, cost_micros)::text from t_metrics where grain = 'organization'),
  '(240,100,2400)',
  'model usage of the period’s tasks, from their attempts'
);
select bag_eq(
  $$ select grain, key, tasks_created, tasks_completed, tasks_verified from t_metrics where grain <> 'organization' $$,
  $$ values
    ('department', 'sales', 3::bigint, 2::bigint, 1::bigint),
    ('department', 'unspecified', 3::bigint, 0::bigint, 0::bigint),
    ('employee', 'a2000000-0000-4000-8000-00000000000e', 3::bigint, 2::bigint, 1::bigint),
    ('employee', 'a2000000-0000-4000-8000-000000000001', 3::bigint, 0::bigint, 0::bigint),
    ('workflow', 'a5000000-0000-4000-8000-000000000001', 1::bigint, 0::bigint, 0::bigint) $$,
  'department, employee and workflow rows partition the same tasks'
);
select bag_eq(
  $$ select grain, key, failure_class, failure_code, tasks from public.analytics_task_failures('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour') $$,
  $$ values
    ('organization', 'a1000000-0000-4000-8000-000000000000', 'permanent', 'provider_error', 1::bigint),
    ('department', 'unspecified', 'permanent', 'provider_error', 1::bigint),
    ('employee', 'a2000000-0000-4000-8000-000000000001', 'permanent', 'provider_error', 1::bigint) $$,
  'failures by class and code, per scope'
);

-- ===========================================================================
-- Actions, workflows, outcomes
-- ===========================================================================

select bag_eq(
  $$ select grain, key, error_code, actions_requested, actions_succeeded, actions_failed, actions_settled
     from public.analytics_action_metrics('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour')
     where grain in ('organization', 'provider', 'provider_error') $$,
  $$ values
    ('organization', 'a1000000-0000-4000-8000-000000000000', null, 5::bigint, 3::bigint, 1::bigint, 4::bigint),
    ('provider', 'gmail', null, 1::bigint, 0::bigint, 0::bigint, 0::bigint),
    ('provider', 'hubspot', null, 2::bigint, 2::bigint, 0::bigint, 2::bigint),
    ('provider', 'slack', null, 2::bigint, 1::bigint, 1::bigint, 2::bigint),
    ('provider_error', 'slack', 'rate_limited', 1::bigint, 0::bigint, 1::bigint, 1::bigint) $$,
  'AI actions by provider and error (not the person’s own action)'
);

select is(
  (select row(runs_started, runs_open, runs_finished, runs_succeeded, runs_failed)::text
   from public.analytics_workflow_metrics('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour')
   where grain = 'workflow' and key = 'a5000000-0000-4000-8000-000000000001'),
  '(1,1,0,0,0)', 'workflow runs: the fixture run is still running'
);

select bag_eq(
  $$ select grain, key, outcome_key, records, subjects
     from public.analytics_outcome_metrics('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour')
     where grain in ('organization', 'department') $$,
  $$ values
    ('organization', 'a1000000-0000-4000-8000-000000000000', 'crm.contact_created', 1::bigint, 1::bigint),
    ('organization', 'a1000000-0000-4000-8000-000000000000', 'crm.lead_qualified', 1::bigint, 1::bigint),
    ('organization', 'a1000000-0000-4000-8000-000000000000', 'crm.note_logged', 1::bigint, 1::bigint),
    ('organization', 'a1000000-0000-4000-8000-000000000000', 'messaging.message_sent', 1::bigint, 1::bigint),
    ('organization', 'a1000000-0000-4000-8000-000000000000', 'support.ticket_resolved', 1::bigint, 0::bigint),
    ('department', 'sales', 'crm.contact_created', 1::bigint, 1::bigint),
    ('department', 'sales', 'crm.lead_qualified', 1::bigint, 1::bigint),
    ('department', 'sales', 'crm.note_logged', 1::bigint, 1::bigint),
    ('department', 'sales', 'messaging.message_sent', 1::bigint, 1::bigint),
    ('department', 'unspecified', 'support.ticket_resolved', 1::bigint, 0::bigint) $$,
  'outcomes per scope, with distinct subjects'
);

-- ===========================================================================
-- Evidence: the rows behind each number
-- ===========================================================================

select bag_eq(
  $$ select item ->> 'task_id' from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'completed') $$,
  $$ values ('a7000000-0000-4000-8000-0000000000e1'), ('a7000000-0000-4000-8000-0000000000e2') $$,
  'evidence for completed tasks lists exactly the counted tasks'
);
select bag_eq(
  $$ select item ->> 'task_id' from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'intervened') $$,
  $$ values ('a7000000-0000-4000-8000-0000000000e2'), ('a7000000-0000-4000-8000-0000000000e4'), ('a7000000-0000-4000-8000-0000000000e5') $$,
  'evidence for interventions'
);
select bag_eq(
  $$ select item ->> 'task_id' from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'retries', 'department', 'sales') $$,
  $$ values ('a7000000-0000-4000-8000-0000000000e2') $$,
  'a count column works as a flag, within a department'
);
select bag_eq(
  $$ select item ->> 'execution_id' from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'action', 'failed', 'provider_error', 'slack:rate_limited') $$,
  $$ values ('a8000000-0000-4000-8000-0000000000e3') $$,
  'evidence for an integration error'
);
select bag_eq(
  $$ select item ->> 'tool_execution_id' from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'outcome', 'crm.lead_qualified', 'employee', 'a2000000-0000-4000-8000-00000000000e') $$,
  $$ values ('a8000000-0000-4000-8000-0000000000e1') $$,
  'evidence for an outcome links its action'
);
select is(
  (select total from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'created', 'organization', null, 2, 0) limit 1),
  6::bigint, 'a page of evidence reports the full count'
);
select is(
  (select count(*)::int from public.analytics_evidence('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour', 'task', 'no_such_flag')),
  0, 'an unknown flag matches nothing'
);
select ok(
  (select bool_and(not (item ? 'input_redacted') and not (item ? 'result')) from public.analytics_evidence('a1000000-0000-4000-8000-000000000000',
     now() - interval '1 day', now() + interval '1 hour', 'action', 'requested')),
  'evidence rows carry no action payloads'
);

-- ===========================================================================
-- Model usage (admins)
-- ===========================================================================

set local request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  (select sum(cost_micros)::bigint from public.analytics_model_usage('a1000000-0000-4000-8000-000000000000', now() - interval '1 day', now() + interval '1 hour')),
  1500::bigint, 'an admin reads the period’s model spend from usage records'
);

reset role;
select * from finish();
rollback;

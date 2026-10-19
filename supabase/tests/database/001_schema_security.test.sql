-- Structural security checks: RLS coverage, privileges, function hardening.
-- Run: npx supabase test db (local) or npx supabase test db --linked
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- RLS ---------------------------------------------------------------------

select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity $$,
  'every table in public has row level security enabled'
);

select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
       and c.relname not in ('integration_secrets', 'provider_webhook_events',
         'integration_oauth_states', 'integration_rate_limit_windows') $$,
  'every client-visible table has at least one policy (only service-only tables have none)'
);

select is_empty(
  $$ select tablename, policyname from pg_policies
     where schemaname = 'public' and 'anon' = any (roles) and tablename not in ('plans', 'plan_entitlements') $$,
  'no policy applies to anon except the public plan catalog'
);

select is_empty(
  $$ select tablename, policyname from pg_policies where schemaname = 'public' and 'public' = any (roles) $$,
  'no policy is granted to the PUBLIC pseudo-role'
);

-- Table privileges -----------------------------------------------------------

select is_empty(
  $$ select table_name, privilege_type from information_schema.role_table_grants
     where grantee = 'anon' and table_schema = 'public'
       and not (table_name in ('plans', 'plan_entitlements') and privilege_type = 'SELECT') $$,
  'anon has no table privileges except reading the plan catalog'
);

select is_empty(
  $$ select table_name, column_name from information_schema.column_privileges
     where grantee = 'anon' and table_schema = 'public'
       and table_name not in ('plans', 'plan_entitlements') $$,
  'anon has no column privileges'
);

select is_empty(
  $$ select table_name, privilege_type from information_schema.role_table_grants
     where grantee in ('anon', 'authenticated') and table_schema = 'public'
       and table_name in ('integration_secrets', 'provider_webhook_events')
     union all
     select table_name, privilege_type from information_schema.column_privileges
     where grantee in ('anon', 'authenticated') and table_schema = 'public'
       and table_name in ('integration_secrets', 'provider_webhook_events') $$,
  'clients have no privileges at all on credentials or webhook records'
);

select is(
  (select array_agg(privilege_type::text order by privilege_type::text) from information_schema.role_table_grants
   where grantee = 'authenticated' and table_schema = 'public' and table_name = 'audit_logs'),
  array['SELECT'],
  'authenticated can only read audit_logs (no insert, update, delete)'
);

select is_empty(
  $$ select table_name, privilege_type from information_schema.role_table_grants
     where grantee = 'authenticated' and table_schema = 'public'
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
       and table_name in ('workflow_runs', 'tasks', 'task_dependencies', 'task_attempts', 'tool_executions',
         'execution_events', 'approval_requests', 'audit_logs', 'subscriptions', 'usage_records',
         'outcome_records', 'plans', 'plan_entitlements', 'knowledge_chunks', 'workflow_versions',
         'employee_test_runs', 'task_evidence') $$,
  'execution, approval, audit, and billing tables are read-only for clients'
);

select ok(
  not has_column_privilege('authenticated', 'public.organization_invitations', 'token_hash', 'SELECT'),
  'clients cannot read invitation token hashes'
);

select ok(
  not has_column_privilege('authenticated', 'public.task_attempts', 'checkpoint', 'SELECT'),
  'clients cannot read task checkpoints'
);

-- Functions ------------------------------------------------------------------

select is_empty(
  $$ select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as c where c like 'search_path=%') $$,
  'every public and private function pins its search_path'
);

select is_empty(
  $$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  'anon cannot execute any function in public'
);

select is(
  (select array_agg(p.proname::text order by p.proname::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  array['accept_invitation', 'assign_employee_task', 'cancel_employee_task', 'cancel_workflow_run', 'change_employee_status',
    'change_workflow_status', 'complete_handed_off_task', 'create_employee', 'create_invitation', 'create_organization',
    'decide_approval', 'emergency_stop_employee', 'employee_test_summary', 'get_invitation', 'hand_off_employee_task',
    'lift_emergency_stop', 'match_knowledge_chunks', 'pause_employee_task', 'reassign_employee_task',
    'reply_to_employee_task', 'reprocess_knowledge_source', 'resume_employee_task', 'retry_employee_task',
    'review_employee_test_run', 'revoke_employee_tool', 'save_employee_version', 'search_knowledge',
    'set_emergency_stop', 'set_employee_task_priority', 'set_retention_settings', 'start_workflow_run'],
  'authenticated can call exactly the intended RPCs'
);

select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon has no access to the private schema');

select ok(
  not has_function_privilege('authenticated', 'private.purge_audit_logs(timestamptz)', 'EXECUTE'),
  'clients cannot purge audit logs'
);

-- Data types -----------------------------------------------------------------

select is_empty(
  $$ select table_name, column_name from information_schema.columns
     where table_schema = 'public' and column_name like '%\_at' and data_type <> 'timestamp with time zone' $$,
  'every *_at column is timestamptz'
);

select ok(
  (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
   where a.attrelid = 'public.knowledge_chunks'::regclass and a.attname = 'embedding') like '%vector(1024)',
  'knowledge_chunks.embedding is vector(1024) (Voyage voyage-4)'
);

select is_empty(
  $$ select table_name, column_name from information_schema.columns
     where table_schema = 'public' and data_type in ('real', 'double precision', 'money')
       and (column_name like '%amount%' or column_name like '%price%' or column_name like '%cost%' or column_name like '%value%') $$,
  'no money column uses floating point or the money type'
);

select * from finish();
rollback;

-- Indexes for tenant foreign keys that had no index leading with the child
-- column (found by the Supabase performance advisor). Composite FKs whose child
-- column already leads another index (e.g. unique (task_id, attempt_number))
-- are left as they are; user-reference columns (created_by, updated_by, …)
-- stay unindexed on purpose — users are rarely deleted.

create index approval_requests_employee_idx on public.approval_requests (employee_id)
  where employee_id is not null;
create index approval_requests_employee_version_idx on public.approval_requests (employee_version_id)
  where employee_version_id is not null;
create index approval_requests_policy_idx on public.approval_requests (policy_id)
  where policy_id is not null;
create index approval_requests_run_idx on public.approval_requests (workflow_run_id)
  where workflow_run_id is not null;
create index approval_requests_workflow_version_idx on public.approval_requests (workflow_version_id)
  where workflow_version_id is not null;
create index tasks_employee_version_idx on public.tasks (employee_version_id)
  where employee_version_id is not null;
create index tool_executions_task_attempt_idx on public.tool_executions (task_attempt_id)
  where task_attempt_id is not null;
create index ai_employees_current_version_idx on public.ai_employees (current_version_id)
  where current_version_id is not null;
create index workflow_definitions_current_version_idx on public.workflow_definitions (current_version_id)
  where current_version_id is not null;

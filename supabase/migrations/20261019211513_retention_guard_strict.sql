-- Retention guards: an unset purge flag means "not purging".
--
-- governance_controls computed "is the retention purge running" as
-- current_setting('nexefiy.retention_purge', true) = 'on'. When the setting was
-- never set in the session that is NULL, not false, so the payload checks
-- evaluated to NULL and were skipped: server code could rewrite a finished
-- action's input_redacted (by also setting payload_purged_at) or a decided
-- approval's proposed_action. Clients have no write access to either table;
-- this closes the gap for server code and the database owner.
--
-- While purging, only the exact shape purge_expired_task_data writes is
-- accepted, and only once:
--   tool_executions   input_redacted = '{}', output_redacted null, payload_purged_at
--                     set, on a finished execution not purged before
--   approval_requests proposed_action = {purged: true, action, actionTitle}
--                     copied from the old value, on a decided request
-- A purge mark, once set, cannot be cleared or moved.

create or replace function private.guard_tool_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_purging boolean := coalesce(current_setting('nexefiy.retention_purge', true), '') = 'on'
    and old.finished_at is not null
    and old.payload_purged_at is null
    and new.payload_purged_at is not null
    and new.input_redacted = '{}'::jsonb
    and new.output_redacted is null;
begin
  if new.input_sha256 <> old.input_sha256
     or (new.input_redacted is distinct from old.input_redacted and not v_purging)
     or (old.payload_purged_at is not null and new.payload_purged_at is distinct from old.payload_purged_at)
     or new.tool_key <> old.tool_key
     or new.risk_level <> old.risk_level
     or new.policy_decision <> old.policy_decision
     or new.idempotency_key <> old.idempotency_key
     or new.task_id <> old.task_id
     or new.action_category is distinct from old.action_category and old.action_category is not null
     or new.risk_tier is distinct from old.risk_tier and old.risk_tier is not null
     or (new.integration_id is distinct from old.integration_id and new.integration_id is not null)
     or (new.employee_id is distinct from old.employee_id and new.employee_id is not null) then
    raise exception 'a tool execution''s proposed action cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Only a signed-in member with the required role approves — never the
-- service role an employee or workflow runs as — and, when the approval asks
-- for a separate approver, never the person who requested the action.
create or replace function private.guard_approval_request()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_execution public.tool_executions;
  v_task public.tasks;
  v_uid uuid := (select auth.uid());
  v_purging boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'approval requests start as pending' using errcode = '23514';
    end if;
    if new.kind = 'workflow_gate' then
      select * into v_task from public.tasks as t where t.id = new.task_id;
      if v_task.id is null
         or v_task.workflow_run_id is distinct from new.workflow_run_id
         or v_task.organization_id <> new.organization_id
         or v_task.employee_id is not null
         or v_task.status <> 'waiting_approval' then
        raise exception 'a workflow approval must belong to a waiting approval step'
          using errcode = '23514';
      end if;
      -- The fingerprint is always computed here, from what the approver sees.
      new.payload_sha256 := private.sha256_hex(new.proposed_action::text);
      return new;
    end if;
    select * into v_execution from public.tool_executions as e where e.id = new.tool_execution_id;
    if v_execution.input_sha256 <> new.payload_sha256
       or v_execution.task_id <> new.task_id
       or v_execution.policy_decision <> 'require_approval'
       or v_execution.status <> 'awaiting_approval' then
      raise exception 'an approval request must match a tool execution that is awaiting approval'
        using errcode = '23514';
    end if;
    return new;
  end if;

  v_purging := coalesce(current_setting('nexefiy.retention_purge', true), '') = 'on'
    and old.status <> 'pending'
    and not (old.proposed_action ? 'purged')
    and new.proposed_action = jsonb_build_object('purged', true, 'action', old.proposed_action -> 'action',
      'actionTitle', old.proposed_action -> 'actionTitle');
  if new.organization_id <> old.organization_id
     or new.kind <> old.kind
     or new.tool_execution_id is distinct from old.tool_execution_id
     or new.task_id <> old.task_id
     or new.payload_sha256 <> old.payload_sha256
     or (new.proposed_action <> old.proposed_action and not v_purging)
     or new.action_summary <> old.action_summary
     or new.required_role <> old.required_role
     or new.expires_at <> old.expires_at
     or new.separate_approver <> old.separate_approver
     or new.binding <> old.binding
     or new.risk_tier is distinct from old.risk_tier
     or new.action_category is distinct from old.action_category then
    raise exception 'the proposed action of an approval request cannot be changed' using errcode = '42501';
  end if;
  if old.status <> 'pending' and new.status <> old.status then
    raise exception 'approval request is already %', old.status using errcode = '55000';
  end if;

  if new.status = 'approved' and old.status = 'pending' then
    if v_uid is null or new.decided_by is distinct from v_uid
       or not private.has_min_role(new.organization_id, new.required_role) then
      raise exception 'only a signed-in member with the required role can approve' using errcode = '42501';
    end if;
    if new.separate_approver and new.kind = 'tool_action' and exists (
      select 1 from public.tool_executions as e where e.id = new.tool_execution_id and e.requested_by = v_uid
    ) then
      raise exception 'someone other than the requester must approve this action' using errcode = '42501';
    end if;
    if private.emergency_stopped(new.organization_id) then
      raise exception 'the emergency stop is active in this workspace' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

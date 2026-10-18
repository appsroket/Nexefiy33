-- Integration framework: OAuth connection state, token refresh leases,
-- shared provider rate-limit windows, connection health, and what the tool
-- executor needs to run an approved action exactly as it was approved.
--
-- Everything added here is written by trusted server code (service role).
-- Clients keep the access they already had: members read connection metadata
-- and tool executions; admins rename connections and configure actions.

-- ---------------------------------------------------------------------------
-- Connection health
-- ---------------------------------------------------------------------------

alter table public.integrations
  add column health_status text not null default 'unknown'
    check (health_status in ('unknown', 'healthy', 'degraded', 'unhealthy')),
  add column health_message text
    check (char_length(health_message) <= 500 and not private.text_contains_secret(health_message)),
  add constraint integrations_last_error_has_no_secret
    check (not private.text_contains_secret(last_error));

create index integrations_health_due_idx on public.integrations (last_health_check_at nulls first)
  where status = 'connected';

-- ---------------------------------------------------------------------------
-- OAuth authorization state
--
-- One row per "Connect" click. Only a SHA-256 of the state value is stored;
-- the raw value travels to the provider and back in the redirect. A state is
-- single use, expires within minutes, and is bound to the organization and the
-- user who started the flow.
-- ---------------------------------------------------------------------------

create table public.integration_oauth_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  state_sha256 text not null unique check (state_sha256 ~ '^[0-9a-f]{64}$'),
  -- Connection being re-authorized, when reconnecting an existing one.
  integration_id uuid,
  return_path text not null default '/app/integrations'
    check (return_path ~ '^/app(/[A-Za-z0-9/_-]*)?$' and char_length(return_path) <= 300),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (integration_id, organization_id)
    references public.integrations (id, organization_id) on delete cascade,
  check (expires_at > created_at and expires_at <= created_at + interval '1 hour')
);

create index integration_oauth_states_org_idx on public.integration_oauth_states (organization_id);
create index integration_oauth_states_user_idx on public.integration_oauth_states (user_id);
create index integration_oauth_states_integration_idx on public.integration_oauth_states (integration_id)
  where integration_id is not null;
create index integration_oauth_states_expires_idx on public.integration_oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- Token refresh lease
--
-- Refreshing a token is an HTTP call that cannot run inside a database
-- transaction, so concurrent refreshes are serialized with a short lease:
-- the server takes it with a conditional update, refreshes, and clears it.
-- ---------------------------------------------------------------------------

alter table public.integration_secrets
  add column refresh_lease_until timestamptz;

-- ---------------------------------------------------------------------------
-- Provider rate limits
--
-- Fixed-window request counters per connection and bucket, shared by every
-- server instance. Provider 429 responses remain the final authority; these
-- windows keep Nexefiy under the published limits in the first place.
-- ---------------------------------------------------------------------------

create table public.integration_rate_limit_windows (
  organization_id uuid not null,
  integration_id uuid not null,
  bucket text not null check (bucket ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (integration_id, bucket, window_start),
  foreign key (integration_id, organization_id)
    references public.integrations (id, organization_id) on delete cascade
);

create index integration_rate_limit_windows_org_idx on public.integration_rate_limit_windows (organization_id);

create function public.consume_integration_rate_limit(
  p_organization_id uuid,
  p_integration_id uuid,
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_ms integer)
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window timestamptz;
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid rate limit' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);

  insert into public.integration_rate_limit_windows as w (organization_id, integration_id, bucket, window_start, request_count)
  values (p_organization_id, p_integration_id, p_bucket, v_window, 1)
  on conflict (integration_id, bucket, window_start)
  do update set request_count = w.request_count + 1
    where w.organization_id = excluded.organization_id
  returning w.request_count into v_count;

  if v_count is null then
    raise exception 'integration not found' using errcode = 'P0002';
  end if;

  if v_count = 1 then
    -- First request of a new window: delete this connection's old windows.
    delete from public.integration_rate_limit_windows as w
    where w.integration_id = p_integration_id
      and w.organization_id = p_organization_id
      and w.window_start < v_window - interval '1 day';
  end if;

  allowed := v_count <= p_limit;
  retry_after_ms := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - v_now)) * 1000)::integer)
  end;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tool executions: exact input until it runs, attempts, and an execution lease
-- ---------------------------------------------------------------------------

alter table public.tool_executions
  -- The exact validated input, kept only until the action finishes so an
  -- approved action runs with precisely the payload whose fingerprint
  -- (input_sha256) was approved. Not readable by clients.
  add column pending_input jsonb
    check (pending_input is null or (jsonb_typeof(pending_input) = 'object' and not private.jsonb_contains_secret(pending_input))),
  add column attempt_count smallint not null default 0 check (attempt_count between 0 and 20),
  add column lease_expires_at timestamptz,
  add column requested_by uuid references auth.users (id) on delete set null,
  add constraint tool_executions_pending_input_cleared
    check (pending_input is null or status in ('proposed', 'awaiting_approval', 'approved', 'executing')),
  add constraint tool_executions_lease_while_executing
    check ((status = 'executing') = (lease_expires_at is not null));

create index tool_executions_requested_by_idx on public.tool_executions (requested_by) where requested_by is not null;
create index tool_executions_claimable_idx on public.tool_executions (status, lease_expires_at)
  where status in ('approved', 'executing');

-- The pending input may be cleared but never replaced. It is cleared, and the
-- lease released, automatically when an execution leaves the states that can
-- still run (so decide_approval's reject and expire paths need no change).
create function private.manage_tool_execution_input()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pending_input is distinct from old.pending_input and new.pending_input is not null then
    raise exception 'a tool execution''s input cannot be changed' using errcode = '42501';
  end if;
  if new.status in ('rejected', 'cancelled', 'skipped', 'succeeded', 'failed') then
    new.pending_input := null;
  end if;
  if new.status <> 'executing' then
    new.lease_expires_at := null;
  end if;
  return new;
end;
$$;

create trigger manage_tool_execution_input before update on public.tool_executions
  for each row execute function private.manage_tool_execution_input();

-- Members keep reading every column except the pending input.
revoke select on public.tool_executions from authenticated;
grant select (
  id, organization_id, task_id, task_attempt_id, employee_id, integration_id, tool_key, risk_level,
  input_redacted, input_sha256, output_redacted, output_ref, status, policy_decision, policy_reason,
  policy_id, idempotency_key, error, started_at, finished_at, created_at, updated_at,
  attempt_count, lease_expires_at, requested_by
) on public.tool_executions to authenticated;

-- Claims approved executions that have not started, and executions whose
-- lease expired (the server running them stopped). Each claimed row is moved
-- to "executing" with a fresh lease; "recovered" tells the caller the action
-- may already have reached the provider, so only idempotent actions may be
-- sent again.
create function public.claim_tool_executions(p_limit integer default 10, p_lease_seconds integer default 120)
returns table (tool_execution_id uuid, organization_id uuid, attempt smallint, recovered boolean)
language plpgsql
set search_path = ''
as $$
begin
  if p_limit not between 1 and 100 or p_lease_seconds not between 10 and 3600 then
    raise exception 'invalid claim parameters' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select t.id, t.status = 'executing' as was_executing
    from public.tool_executions as t
    where (t.status = 'approved')
       or (t.status = 'executing' and t.lease_expires_at < now())
    order by t.created_at
    limit p_limit
    for update skip locked
  )
  update public.tool_executions as t
  set status = 'executing',
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = least(t.attempt_count + 1, 20),
      started_at = coalesce(t.started_at, now())
  from candidates as c
  where t.id = c.id
  returning t.id, t.organization_id, t.attempt_count, c.was_executing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- ---------------------------------------------------------------------------

alter table public.integration_oauth_states enable row level security;
alter table public.integration_rate_limit_windows enable row level security;

-- Service role only: no client grants and no policies.
revoke all on public.integration_oauth_states, public.integration_rate_limit_windows from anon, authenticated;

revoke all on function public.consume_integration_rate_limit(uuid, uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_tool_executions(integer, integer) from public, anon, authenticated;
grant execute on function public.consume_integration_rate_limit(uuid, uuid, text, integer, integer) to service_role;
grant execute on function public.claim_tool_executions(integer, integer) to service_role;

comment on table public.integration_oauth_states is
  'Pending OAuth authorizations (hashed state, single use). Service role only.';
comment on table public.integration_rate_limit_windows is
  'Shared provider rate-limit counters per connection. Service role only.';

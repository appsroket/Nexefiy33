-- Workflows: editable definitions, immutable published versions, triggers.
--
-- workflow_definitions holds metadata and the in-progress draft graph.
-- Publishing creates an immutable workflow_versions row; runs pin a version.
-- Published graphs must pass the versioned JSON schema plus structural checks
-- here, and semantic validation (tools, grants, connections, policies) in the
-- application before the server inserts them — so clients cannot publish.

create table public.workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (char_length(description) <= 5000),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  -- Drafts may be incomplete while editing, so only their shape is checked.
  draft_schema_version integer not null default 1,
  draft_graph jsonb not null default '{"nodes": [], "edges": []}'::jsonb
    check (jsonb_typeof(draft_graph) = 'object' and not private.jsonb_contains_secret(draft_graph)),
  current_version_id uuid,
  -- Incremented on every update; clients send it back for optimistic locking.
  lock_version integer not null default 0,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, name),
  check (status in ('draft', 'archived') or current_version_id is not null)
);

create index workflow_definitions_org_status_idx on public.workflow_definitions (organization_id, status);

create table public.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workflow_id uuid not null,
  -- Assigned by trigger: 1, 2, 3 … per workflow.
  version integer not null check (version >= 1),
  graph_schema_version integer not null default 1,
  graph jsonb not null,
  -- SHA-256 of the canonical (jsonb) graph text, computed by trigger.
  graph_sha256 text not null check (graph_sha256 ~ '^[0-9a-f]{64}$'),
  validation_report jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_report) = 'object'),
  source text not null default 'manual' check (source in ('manual', 'ai_generated', 'imported')),
  generation_metadata jsonb
    check (generation_metadata is null or (jsonb_typeof(generation_metadata) = 'object'
      and not private.jsonb_contains_secret(generation_metadata))),
  published_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workflow_id, organization_id)
    references public.workflow_definitions (id, organization_id) on delete cascade,
  unique (workflow_id, version),
  unique (id, workflow_id),
  unique (id, organization_id),
  constraint workflow_versions_graph_valid check (private.workflow_graph_is_valid(graph_schema_version, graph)),
  constraint workflow_versions_graph_has_no_secrets check (not private.jsonb_contains_secret(graph))
);

create index workflow_versions_org_idx on public.workflow_versions (organization_id);

alter table public.workflow_definitions
  add constraint workflow_definitions_current_version_fk
  foreign key (current_version_id, id) references public.workflow_versions (id, workflow_id);

create table public.workflow_triggers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workflow_id uuid not null,
  trigger_type text not null check (trigger_type in ('manual', 'schedule', 'integration_event', 'webhook')),
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object' and not private.jsonb_contains_secret(config)),
  integration_id uuid,
  event_type text check (event_type ~ '^[a-z][a-z0-9_.]{1,99}$'),
  cron_expression text check (char_length(cron_expression) between 9 and 100),
  timezone text check (char_length(timezone) between 1 and 64),
  -- SHA-256 of the webhook trigger's shared secret; the secret is never stored.
  webhook_secret_hash text check (webhook_secret_hash ~ '^[0-9a-f]{64}$'),
  next_run_at timestamptz,
  last_fired_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workflow_id, organization_id)
    references public.workflow_definitions (id, organization_id) on delete cascade,
  foreign key (integration_id, organization_id)
    references public.integrations (id, organization_id) on delete cascade,
  unique (id, organization_id),
  check ((trigger_type = 'schedule') = (cron_expression is not null)),
  check ((trigger_type = 'integration_event') = (integration_id is not null and event_type is not null)),
  check ((trigger_type = 'webhook') = (webhook_secret_hash is not null))
);

create index workflow_triggers_workflow_idx on public.workflow_triggers (workflow_id);
create index workflow_triggers_org_idx on public.workflow_triggers (organization_id, trigger_type) where enabled;
create index workflow_triggers_integration_idx on public.workflow_triggers (integration_id, event_type)
  where integration_id is not null and enabled;
create index workflow_triggers_due_idx on public.workflow_triggers (next_run_at)
  where trigger_type = 'schedule' and enabled;

create function private.bump_lock_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.lock_version := old.lock_version + 1;
  return new;
end;
$$;

create function private.assign_workflow_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workflow_version:' || new.workflow_id::text, 0));
  select coalesce(max(v.version), 0) + 1 into new.version
  from public.workflow_versions as v
  where v.workflow_id = new.workflow_id;
  new.graph_sha256 := private.sha256_hex(new.graph::text);
  return new;
end;
$$;

create trigger set_updated_at before update on public.workflow_definitions
  for each row execute function private.set_updated_at();
create trigger stamp_updated_by before update on public.workflow_definitions
  for each row execute function private.stamp_updated_by();
create trigger bump_lock_version before update on public.workflow_definitions
  for each row execute function private.bump_lock_version();
create trigger assign_workflow_version before insert on public.workflow_versions
  for each row execute function private.assign_workflow_version();
create trigger prevent_update before update on public.workflow_versions
  for each row execute function private.prevent_update();
create trigger set_updated_at before update on public.workflow_triggers
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- Members read; operators edit drafts, triggers, and which published version
-- is current (rollback). Only the server publishes versions.
-- ---------------------------------------------------------------------------

alter table public.workflow_definitions enable row level security;
alter table public.workflow_versions enable row level security;
alter table public.workflow_triggers enable row level security;

revoke all on public.workflow_definitions, public.workflow_versions, public.workflow_triggers
from anon, authenticated;

grant select, delete on public.workflow_definitions to authenticated;
grant insert (organization_id, name, description, draft_schema_version, draft_graph)
  on public.workflow_definitions to authenticated;
grant update (name, description, status, draft_schema_version, draft_graph, current_version_id)
  on public.workflow_definitions to authenticated;

create policy "workflow_definitions: members read" on public.workflow_definitions
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "workflow_definitions: operators create" on public.workflow_definitions
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "workflow_definitions: operators update" on public.workflow_definitions
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')))
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "workflow_definitions: operators delete" on public.workflow_definitions
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')));

grant select on public.workflow_versions to authenticated;

create policy "workflow_versions: members read" on public.workflow_versions
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

grant select, delete on public.workflow_triggers to authenticated;
grant insert (organization_id, workflow_id, trigger_type, enabled, config, integration_id, event_type,
  cron_expression, timezone, webhook_secret_hash)
  on public.workflow_triggers to authenticated;
grant update (enabled, config, event_type, cron_expression, timezone, webhook_secret_hash)
  on public.workflow_triggers to authenticated;

create policy "workflow_triggers: members read" on public.workflow_triggers
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "workflow_triggers: operators create" on public.workflow_triggers
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "workflow_triggers: operators update" on public.workflow_triggers
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')))
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "workflow_triggers: operators delete" on public.workflow_triggers
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')));

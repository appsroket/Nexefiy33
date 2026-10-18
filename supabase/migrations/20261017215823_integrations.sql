-- Integrations: connections to external providers, the actions enabled on each
-- connection, and encrypted credentials.
--
-- Credentials are encrypted by the application (AES-256-GCM envelope
-- "nxf1.<keyId>.<iv>.<ciphertext>.<tag>", ADR-014) before they reach the
-- database. integration_secrets has RLS enabled with no policies and no client
-- privileges: only trusted server code (service role) can read or write it.

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  status text not null default 'pending'
    check (status in ('pending', 'connected', 'needs_reauth', 'error', 'revoked')),
  external_account_id text check (char_length(external_account_id) <= 255),
  external_account_label text check (char_length(external_account_label) <= 255),
  granted_scopes text[] not null default '{}'
    check (cardinality(granted_scopes) <= 100 and array_position(granted_scopes, null) is null),
  provider_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_metadata) = 'object' and not private.jsonb_contains_secret(provider_metadata)),
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz,
  last_health_check_at timestamptz,
  last_error text check (char_length(last_error) <= 2000),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check (status <> 'connected' or (connected_at is not null and external_account_id is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index integrations_account_idx
  on public.integrations (organization_id, provider, external_account_id)
  where external_account_id is not null;
create index integrations_org_status_idx on public.integrations (organization_id, status);

create table public.integration_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  integration_id uuid not null,
  action_key text not null check (action_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  risk_level text not null check (risk_level in ('read', 'write_internal', 'write_external', 'sensitive')),
  enabled boolean not null default true,
  approval_mode text not null default 'require_approval'
    check (approval_mode in ('allow', 'require_approval', 'deny')),
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object' and not private.jsonb_contains_secret(config)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (integration_id, organization_id)
    references public.integrations (id, organization_id) on delete cascade,
  unique (integration_id, action_key),
  -- Sensitive actions always need a human (ADR-012).
  check (risk_level <> 'sensitive' or approval_mode <> 'allow')
);

create index integration_actions_org_idx on public.integration_actions (organization_id);

create table public.integration_secrets (
  integration_id uuid not null,
  organization_id uuid not null,
  secret_kind text not null check (secret_kind in ('oauth_tokens', 'api_key', 'webhook_secret')),
  ciphertext text not null
    check (ciphertext ~ '^nxf1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  -- Encryption key id, duplicated from the envelope so rotation can find rows.
  key_id text not null,
  access_token_expires_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (integration_id, secret_kind),
  foreign key (integration_id, organization_id)
    references public.integrations (id, organization_id) on delete cascade,
  check (key_id = split_part(ciphertext, '.', 2))
);

create index integration_secrets_key_idx on public.integration_secrets (key_id);
create index integration_secrets_org_idx on public.integration_secrets (organization_id);

create trigger set_updated_at before update on public.integrations
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.integration_actions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.integration_secrets
  for each row execute function private.set_updated_at();

-- Deferred foreign keys from earlier modules.
alter table public.knowledge_sources
  add constraint knowledge_sources_integration_fk
  foreign key (integration_id, organization_id)
  references public.integrations (id, organization_id) on delete cascade;

alter table public.employee_tool_permissions
  add constraint employee_tool_permissions_integration_fk
  foreign key (integration_id, organization_id)
  references public.integrations (id, organization_id) on delete cascade;

create index knowledge_sources_integration_idx on public.knowledge_sources (integration_id)
  where integration_id is not null;
create index employee_tool_permissions_integration_idx on public.employee_tool_permissions (integration_id)
  where integration_id is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- Connections are created by the server-side OAuth callback. Members can see
-- connection metadata; admins can rename, remove, and configure actions.
-- ---------------------------------------------------------------------------

alter table public.integrations enable row level security;
alter table public.integration_actions enable row level security;
alter table public.integration_secrets enable row level security;

revoke all on public.integrations, public.integration_actions, public.integration_secrets
from anon, authenticated;

grant select, delete on public.integrations to authenticated;
grant update (display_name) on public.integrations to authenticated;

create policy "integrations: members read" on public.integrations
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "integrations: admins update" on public.integrations
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')))
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "integrations: admins delete" on public.integrations
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

grant select, delete on public.integration_actions to authenticated;
grant insert (organization_id, integration_id, action_key, risk_level, enabled, approval_mode, config)
  on public.integration_actions to authenticated;
grant update (enabled, approval_mode, config) on public.integration_actions to authenticated;

create policy "integration_actions: members read" on public.integration_actions
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "integration_actions: admins create" on public.integration_actions
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "integration_actions: admins update" on public.integration_actions
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')))
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "integration_actions: admins delete" on public.integration_actions
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

-- integration_secrets: intentionally no grants and no policies for clients.
comment on table public.integration_secrets is
  'Encrypted integration credentials. Service role only; never exposed to clients.';

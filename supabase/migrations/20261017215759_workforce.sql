-- AI workforce: skills catalog, employees, immutable versioned configuration,
-- employee skills, and per-employee tool permissions.
--
-- Employee configuration and instructions live in employee_versions, which
-- are immutable and validated against a versioned JSON schema. Configuration
-- JSON may never contain provider credentials (private.jsonb_contains_secret).

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  -- NULL = built-in skill available to every organization.
  organization_id uuid references public.organizations (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (char_length(description) <= 2000),
  category text not null check (category in (
    'communication', 'sales', 'support', 'marketing', 'operations', 'analytics',
    'finance', 'hr', 'research', 'productivity', 'custom'
  )),
  instructions text check (char_length(instructions) <= 20000 and not private.text_contains_secret(instructions)),
  tool_keys text[] not null default '{}'
    check (cardinality(tool_keys) <= 50 and array_position(tool_keys, null) is null),
  status text not null default 'active' check (status in ('active', 'deprecated')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, key)
);

create index skills_org_idx on public.skills (organization_id);

create table public.ai_employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  role_category text not null check (role_category in (
    'voice', 'sales', 'marketing', 'support', 'analytics', 'operations',
    'executive_assistant', 'finance_admin', 'hr_admin', 'research', 'custom'
  )),
  description text check (char_length(description) <= 2000),
  avatar_url text check (avatar_url ~ '^https://'),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  current_version_id uuid,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, name),
  -- An employee cannot be activated without a configuration version.
  check (status in ('draft', 'archived') or current_version_id is not null)
);

create index ai_employees_org_status_idx on public.ai_employees (organization_id, status);

create table public.employee_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  -- Assigned by trigger: 1, 2, 3 … per employee.
  version integer not null check (version >= 1),
  instructions text not null
    check (char_length(instructions) between 1 and 50000 and not private.text_contains_secret(instructions)),
  config_schema_version integer not null default 1,
  config jsonb not null,
  change_note text check (char_length(change_note) <= 1000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete cascade,
  unique (employee_id, version),
  unique (id, employee_id),
  unique (id, organization_id),
  constraint employee_versions_config_valid
    check (private.employee_config_is_valid(config_schema_version, config)),
  constraint employee_versions_config_has_no_secrets
    check (not private.jsonb_contains_secret(config))
);

create index employee_versions_org_idx on public.employee_versions (organization_id);

alter table public.ai_employees
  add constraint ai_employees_current_version_fk
  foreign key (current_version_id, id) references public.employee_versions (id, employee_id);

create table public.employee_skills (
  organization_id uuid not null,
  employee_id uuid not null,
  skill_id uuid not null references public.skills (id) on delete cascade,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object' and not private.jsonb_contains_secret(config)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (employee_id, skill_id),
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete cascade
);

create index employee_skills_org_idx on public.employee_skills (organization_id);
create index employee_skills_skill_idx on public.employee_skills (skill_id);

create table public.employee_tool_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  tool_key text not null check (tool_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- Connection the tool acts through, when it needs one. FK added with integrations.
  integration_id uuid,
  -- Ceiling for this employee; organization policy can only make it stricter.
  decision text not null default 'require_approval'
    check (decision in ('allow', 'require_approval', 'deny')),
  constraints jsonb not null default '{}'::jsonb
    check (jsonb_typeof(constraints) = 'object' and not private.jsonb_contains_secret(constraints)),
  granted_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete cascade,
  unique nulls not distinct (employee_id, tool_key, integration_id)
);

create index employee_tool_permissions_org_idx on public.employee_tool_permissions (organization_id, employee_id);

create trigger set_updated_at before update on public.skills
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.ai_employees
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.employee_skills
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.employee_tool_permissions
  for each row execute function private.set_updated_at();

create trigger prevent_update before update on public.employee_versions
  for each row execute function private.prevent_update();

-- Version numbers are assigned here so clients cannot skip or reuse them.
create function private.assign_employee_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('employee_version:' || new.employee_id::text, 0));
  select coalesce(max(v.version), 0) + 1 into new.version
  from public.employee_versions as v
  where v.employee_id = new.employee_id;
  return new;
end;
$$;

create trigger assign_employee_version before insert on public.employee_versions
  for each row execute function private.assign_employee_version();

-- A skill must be built-in or belong to the employee's organization.
create function private.check_employee_skill_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.skills as s
    where s.id = new.skill_id
      and (s.organization_id is null or s.organization_id = new.organization_id)
  ) then
    raise exception 'skill % is not available to this organization', new.skill_id using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger check_employee_skill_scope before insert or update on public.employee_skills
  for each row execute function private.check_employee_skill_scope();

-- Built-in skills (catalog data, not tenant data).
insert into public.skills (organization_id, key, name, description, category, tool_keys, created_by) values
  (null, 'knowledge.search', 'Knowledge search', 'Answer questions from the organization''s knowledge base with citations.', 'research', '{knowledge.search}', null),
  (null, 'email.correspondence', 'Email correspondence', 'Read, draft, and send email on the organization''s behalf.', 'communication', '{gmail.search,gmail.read,gmail.draft,gmail.send}', null),
  (null, 'calendar.scheduling', 'Calendar scheduling', 'Check availability and schedule meetings.', 'productivity', '{calendar.availability,calendar.list_events,calendar.create_event}', null),
  (null, 'crm.records', 'CRM record keeping', 'Find, create, and update contacts, deals, and notes.', 'sales', '{hubspot.contacts.search,hubspot.contacts.update,hubspot.deals.update,hubspot.notes.create}', null),
  (null, 'chat.messaging', 'Team chat messaging', 'Post updates and read channels in team chat.', 'communication', '{slack.post_message,slack.read_channel}', null);

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- Members read. Operators manage employees, versions, skills. Granting tools
-- to an employee is an admin decision.
-- ---------------------------------------------------------------------------

alter table public.skills enable row level security;
alter table public.ai_employees enable row level security;
alter table public.employee_versions enable row level security;
alter table public.employee_skills enable row level security;
alter table public.employee_tool_permissions enable row level security;

revoke all on public.skills, public.ai_employees, public.employee_versions,
  public.employee_skills, public.employee_tool_permissions
from anon, authenticated;

-- skills
grant select, delete on public.skills to authenticated;
grant insert (organization_id, key, name, description, category, instructions, tool_keys)
  on public.skills to authenticated;
grant update (name, description, category, instructions, tool_keys, status) on public.skills to authenticated;

create policy "skills: read built-in and own organization" on public.skills
  for select to authenticated
  using (organization_id is null or organization_id in (select private.member_org_ids()));

create policy "skills: operators create" on public.skills
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "skills: operators update" on public.skills
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')))
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "skills: operators delete" on public.skills
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')));

-- ai_employees
grant select, delete on public.ai_employees to authenticated;
grant insert (organization_id, name, role_category, description, avatar_url) on public.ai_employees to authenticated;
grant update (name, role_category, description, avatar_url, status, current_version_id)
  on public.ai_employees to authenticated;

create policy "ai_employees: members read" on public.ai_employees
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "ai_employees: operators create" on public.ai_employees
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "ai_employees: operators update" on public.ai_employees
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')))
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "ai_employees: operators delete" on public.ai_employees
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')));

-- employee_versions: append-only
grant select on public.employee_versions to authenticated;
grant insert (organization_id, employee_id, instructions, config_schema_version, config, change_note)
  on public.employee_versions to authenticated;

create policy "employee_versions: members read" on public.employee_versions
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "employee_versions: operators create" on public.employee_versions
  for insert to authenticated
  with check (
    organization_id in (select private.org_ids_with_min_role('operator'))
    and created_by = (select auth.uid())
  );

-- employee_skills
grant select, delete on public.employee_skills to authenticated;
grant insert (organization_id, employee_id, skill_id, enabled, config) on public.employee_skills to authenticated;
grant update (enabled, config) on public.employee_skills to authenticated;

create policy "employee_skills: members read" on public.employee_skills
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "employee_skills: operators create" on public.employee_skills
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "employee_skills: operators update" on public.employee_skills
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')))
  with check (organization_id in (select private.org_ids_with_min_role('operator')));

create policy "employee_skills: operators delete" on public.employee_skills
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')));

-- employee_tool_permissions: admins only
grant select, delete on public.employee_tool_permissions to authenticated;
grant insert (organization_id, employee_id, tool_key, integration_id, decision, constraints)
  on public.employee_tool_permissions to authenticated;
grant update (decision, constraints) on public.employee_tool_permissions to authenticated;

create policy "employee_tool_permissions: members read" on public.employee_tool_permissions
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "employee_tool_permissions: admins create" on public.employee_tool_permissions
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "employee_tool_permissions: admins update" on public.employee_tool_permissions
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')))
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "employee_tool_permissions: admins delete" on public.employee_tool_permissions
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

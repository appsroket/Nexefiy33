-- Identity and organizations: profiles, organizations, memberships,
-- invitations, company settings. Supabase Auth (auth.users) is the only
-- identity source; there is no separate password system.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text check (char_length(full_name) <= 200),
  avatar_url text check (avatar_url ~ '^https://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'operator', 'viewer')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  invited_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  check ((status = 'revoked') = (revoked_at is not null))
);

create index organization_members_user_idx on public.organization_members (user_id, organization_id)
  where status = 'active';

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('admin', 'operator', 'viewer')),
  -- SHA-256 of the invitation token; the token itself is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid references auth.users (id) on delete set null,
  accepted_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((status = 'accepted') = (accepted_at is not null))
);

create unique index organization_invitations_pending_email_idx
  on public.organization_invitations (organization_id, email)
  where status = 'pending';

create table public.company_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  legal_name text check (char_length(legal_name) <= 200),
  industry text check (char_length(industry) <= 100),
  description text check (char_length(description) <= 5000),
  website text check (website ~ '^https?://' and char_length(website) <= 500),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  locale text not null default 'en' check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  default_currency text not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  brand_voice text check (char_length(brand_voice) <= 2000),
  settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object' and not private.jsonb_contains_secret(settings)),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.organizations
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.organization_members
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.organization_invitations
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.company_settings
  for each row execute function private.set_updated_at();
create trigger stamp_updated_by before update on public.company_settings
  for each row execute function private.stamp_updated_by();

-- ---------------------------------------------------------------------------
-- Membership helpers used by every RLS policy.
--
-- SECURITY DEFINER so policies can read memberships without recursing into
-- organization_members' own RLS. They only ever answer questions about the
-- calling user (auth.uid()); no caller-supplied user id is accepted.
-- ---------------------------------------------------------------------------

create function private.member_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_members as m
  where m.user_id = (select auth.uid())
    and m.status = 'active';
$$;

create function private.org_ids_with_min_role(p_min_role text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_members as m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and private.role_rank(m.role) >= private.role_rank(p_min_role);
$$;

create function private.has_min_role(p_organization_id uuid, p_min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and private.role_rank(m.role) >= private.role_rank(p_min_role)
  );
$$;

-- Users who share at least one organization with the caller (for profiles).
create function private.co_member_user_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct other.user_id
  from public.organization_members as mine
  join public.organization_members as other on other.organization_id = mine.organization_id
  where mine.user_id = (select auth.uid())
    and mine.status = 'active';
$$;

revoke all on function
  private.member_org_ids(),
  private.org_ids_with_min_role(text),
  private.has_min_role(uuid, text),
  private.co_member_user_ids()
from public, anon;
grant execute on function
  private.member_org_ids(),
  private.org_ids_with_min_role(text),
  private.has_min_role(uuid, text),
  private.co_member_user_ids()
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Profiles follow auth.users.
-- ---------------------------------------------------------------------------

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 200), ''),
    case when new.raw_user_meta_data ->> 'avatar_url' ~ '^https://' then new.raw_user_meta_data ->> 'avatar_url' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create function private.sync_user_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.sync_user_email();

-- ---------------------------------------------------------------------------
-- Membership guard.
--
-- SECURITY INVOKER on purpose: `current_user` is then 'authenticated' for
-- direct Data API calls (rules apply) and the definer/service role for trusted
-- server code (rules skipped, except the last-owner rule, which always holds).
-- ---------------------------------------------------------------------------

create function private.guard_membership_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_rank integer;
  v_other_owners integer;
begin
  -- The organization itself is being deleted: memberships go with it.
  if not exists (select 1 from public.organizations as o where o.id = old.organization_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Serialize membership changes per organization (last-owner check below).
  perform pg_advisory_xact_lock(hashtextextended('membership:' || old.organization_id::text, 0));

  if tg_op = 'UPDATE' then
    if new.organization_id <> old.organization_id or new.user_id <> old.user_id then
      raise exception 'a membership''s organization and user cannot change' using errcode = '42501';
    end if;
    if new.status = 'revoked' and old.status <> 'revoked' then
      new.revoked_at := now();
      new.revoked_by := v_actor;
    elsif new.status = 'active' then
      new.revoked_at := null;
      new.revoked_by := null;
    end if;
  end if;

  if current_user = 'authenticated' then
    select private.role_rank(m.role) into v_actor_rank
    from public.organization_members as m
    where m.organization_id = old.organization_id and m.user_id = v_actor and m.status = 'active';
    v_actor_rank := coalesce(v_actor_rank, 0);

    if old.user_id = v_actor then
      -- Anyone may leave (DELETE). Only owners may change their own role or status.
      if tg_op = 'UPDATE' and (new.role <> old.role or new.status <> old.status) and v_actor_rank < 4 then
        raise exception 'only owners can change their own membership' using errcode = '42501';
      end if;
    elsif v_actor_rank < 3 then
      raise exception 'only owners and admins can manage members' using errcode = '42501';
    elsif v_actor_rank = 3 and (
      private.role_rank(old.role) >= 3
      or (tg_op = 'UPDATE' and private.role_rank(new.role) >= 3)
    ) then
      raise exception 'admins can only manage operators and viewers' using errcode = '42501';
    end if;
  end if;

  -- An organization always keeps at least one active owner.
  if old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active') then
    select count(*) into v_other_owners
    from public.organization_members as m
    where m.organization_id = old.organization_id
      and m.role = 'owner' and m.status = 'active' and m.user_id <> old.user_id;
    if v_other_owners = 0 then
      raise exception 'an organization must keep at least one owner' using errcode = '23514';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger guard_membership_change
  before update or delete on public.organization_members
  for each row execute function private.guard_membership_change();

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.company_settings enable row level security;

revoke all on public.profiles, public.organizations, public.organization_members,
  public.organization_invitations, public.company_settings
from anon, authenticated;

-- profiles: yourself and people you share an organization with.
grant select on public.profiles to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

create policy "profiles: read self and co-members" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or id in (select private.co_member_user_ids()));

create policy "profiles: update self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- organizations: created through public.create_organization().
grant select on public.organizations to authenticated;
grant update (name, slug) on public.organizations to authenticated;
grant delete on public.organizations to authenticated;

create policy "organizations: members read" on public.organizations
  for select to authenticated
  using (id in (select private.member_org_ids()));

create policy "organizations: admins update" on public.organizations
  for update to authenticated
  using (id in (select private.org_ids_with_min_role('admin')))
  with check (id in (select private.org_ids_with_min_role('admin')));

create policy "organizations: owners delete" on public.organizations
  for delete to authenticated
  using (id in (select private.org_ids_with_min_role('owner')));

-- organization_members: rows are created by create_organization() and
-- accept_invitation(); role/status changes are further checked by
-- private.guard_membership_change().
grant select on public.organization_members to authenticated;
grant update (role, status) on public.organization_members to authenticated;
grant delete on public.organization_members to authenticated;

create policy "organization_members: members read" on public.organization_members
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "organization_members: admins update" on public.organization_members
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')))
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "organization_members: admins remove, members leave" on public.organization_members
  for delete to authenticated
  using (
    organization_id in (select private.org_ids_with_min_role('admin'))
    or (user_id = (select auth.uid()) and organization_id in (select private.member_org_ids()))
  );

-- organization_invitations: created by create_invitation(); admins can list,
-- revoke, and delete. token_hash is never readable by clients.
grant select (id, organization_id, email, role, status, invited_by, accepted_by,
  expires_at, accepted_at, created_at, updated_at)
  on public.organization_invitations to authenticated;
grant update (status) on public.organization_invitations to authenticated;
grant delete on public.organization_invitations to authenticated;

create policy "organization_invitations: admins read" on public.organization_invitations
  for select to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "organization_invitations: admins revoke pending" on public.organization_invitations
  for update to authenticated
  using (status = 'pending' and organization_id in (select private.org_ids_with_min_role('admin')))
  with check (status = 'revoked' and organization_id in (select private.org_ids_with_min_role('admin')));

create policy "organization_invitations: admins delete" on public.organization_invitations
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

-- company_settings: one row per organization, created with it.
grant select on public.company_settings to authenticated;
grant update (legal_name, industry, description, website, timezone, locale,
  default_currency, brand_voice, settings)
  on public.company_settings to authenticated;

create policy "company_settings: members read" on public.company_settings
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "company_settings: admins update" on public.company_settings
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')))
  with check (organization_id in (select private.org_ids_with_min_role('admin')));

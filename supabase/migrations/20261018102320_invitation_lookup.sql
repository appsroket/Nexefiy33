-- Invitation lookup and re-invitation (auth and workspace flow).
--
-- 1. get_invitation(): a signed-in person holding an invitation link can see
--    which workspace it is for, the role, and whether it still works, before
--    accepting it. Only the token holder can look an invitation up.
-- 2. create_invitation(): an invitation that ran out no longer blocks inviting
--    the same address again, and a live one gives a clear error instead of a
--    unique-index violation. Everything else is unchanged.

-- ---------------------------------------------------------------------------
-- get_invitation
-- ---------------------------------------------------------------------------

create function public.get_invitation(p_token text)
returns table (
  organization_id uuid,
  organization_name text,
  role text,
  status text,
  expires_at timestamptz,
  invited_email text,
  email_matches boolean,
  already_member boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Tokens are 32 random bytes in hex; anything else cannot match.
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select lower(u.email) into v_email
  from auth.users as u
  where u.id = v_user and u.email_confirmed_at is not null;

  return query
  select
    i.organization_id,
    o.name,
    i.role,
    case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
    i.expires_at,
    i.email,
    coalesce(i.email = v_email, false),
    exists (
      select 1 from public.organization_members as m
      where m.organization_id = i.organization_id and m.user_id = v_user and m.status = 'active'
    )
  from public.organization_invitations as i
  join public.organizations as o on o.id = i.organization_id
  where i.token_hash = private.sha256_hex(p_token);
end;
$$;

revoke all on function public.get_invitation(text) from public, anon;
grant execute on function public.get_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- create_invitation (replaces the version in 20261017220124_api_functions)
-- ---------------------------------------------------------------------------

create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email text,
  p_role text,
  p_expires_in interval default interval '7 days'
)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_email text := lower(btrim(p_email));
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_role not in ('admin', 'operator', 'viewer') then
    raise exception 'invalid role %', p_role using errcode = '22023';
  end if;
  if not private.has_min_role(p_organization_id, case when p_role = 'admin' then 'owner' else 'admin' end) then
    raise exception 'not allowed to invite % members to this organization', p_role using errcode = '42501';
  end if;
  if p_expires_in < interval '1 hour' or p_expires_in > interval '30 days' then
    raise exception 'invitations must expire between 1 hour and 30 days' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_members as m
    join auth.users as u on u.id = m.user_id
    where m.organization_id = p_organization_id and m.status = 'active' and lower(u.email) = v_email
  ) then
    raise exception 'this person is already a member' using errcode = '23505';
  end if;

  -- An invitation that ran out no longer blocks inviting the address again.
  update public.organization_invitations as i
  set status = 'expired'
  where i.organization_id = p_organization_id
    and i.email = v_email
    and i.status = 'pending'
    and i.expires_at <= now();

  if exists (
    select 1 from public.organization_invitations as i
    where i.organization_id = p_organization_id and i.email = v_email and i.status = 'pending'
  ) then
    raise exception 'this address already has a pending invitation' using errcode = '23505';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
  values (p_organization_id, v_email, p_role, private.sha256_hex(v_token), v_user, now() + p_expires_in)
  returning id, organization_invitations.expires_at into v_id, v_expires;

  return query select v_id, v_token, v_expires;
end;
$$;

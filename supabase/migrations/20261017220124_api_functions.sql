-- Client-callable functions (exposed through the Data API as RPCs).
--
-- Each is SECURITY DEFINER because it writes rows clients cannot write
-- directly, so each one: pins search_path = '', derives the user from
-- auth.uid() (never from arguments), checks membership and role itself, and is
-- executable by `authenticated` only.

-- ---------------------------------------------------------------------------
-- create_organization: the caller becomes its owner.
-- ---------------------------------------------------------------------------

create function public.create_organization(p_name text, p_slug text)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_org public.organizations;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  insert into public.organizations (name, slug, created_by)
  values (btrim(p_name), lower(btrim(p_slug)), v_user)
  returning * into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org.id, v_user, 'owner');

  insert into public.company_settings (organization_id) values (v_org.id);

  -- Safe default: external and sensitive actions need a human (ADR-012).
  insert into public.organization_policies (organization_id, name, description, policy, priority, created_by)
  values (
    v_org.id,
    'Default approval policy',
    'External and sensitive actions require approval.',
    '{"rules": [{"id": "default-approval", "effect": "require_approval", "riskLevels": ["write_external", "sensitive"]}],
      "defaults": {"approvalExpiresInHours": 72}}'::jsonb,
    1000,
    v_user
  );

  return v_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_invitation: returns the one-time token (only its hash is stored).
-- Admins may invite operators and viewers; only owners may invite admins.
-- ---------------------------------------------------------------------------

create function public.create_invitation(
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
    where m.organization_id = p_organization_id and m.status = 'active' and lower(u.email) = lower(btrim(p_email))
  ) then
    raise exception 'this person is already a member' using errcode = '23505';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
  values (p_organization_id, lower(btrim(p_email)), p_role, private.sha256_hex(v_token), v_user, now() + p_expires_in)
  returning id, organization_invitations.expires_at into v_id, v_expires;

  return query select v_id, v_token, v_expires;
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_invitation: the signed-in user's verified email must match.
-- ---------------------------------------------------------------------------

create function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text;
  v_invitation public.organization_invitations;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select lower(u.email) into v_email
  from auth.users as u
  where u.id = v_user and u.email_confirmed_at is not null;

  select * into v_invitation
  from public.organization_invitations as i
  where i.token_hash = private.sha256_hex(coalesce(p_token, ''))
  for update;

  -- One generic error so tokens and emails cannot be probed.
  if v_invitation.id is null
     or v_email is null
     or v_invitation.status <> 'pending'
     or v_invitation.expires_at <= now()
     or v_invitation.email <> v_email then
    raise exception 'invitation is invalid or has expired' using errcode = '22023';
  end if;

  insert into public.organization_members (organization_id, user_id, role, invited_by)
  values (v_invitation.organization_id, v_user, v_invitation.role, v_invitation.invited_by)
  on conflict (organization_id, user_id) do update
    set role = excluded.role, status = 'active', invited_by = excluded.invited_by
    where public.organization_members.status = 'revoked';

  if not found then
    raise exception 'you are already a member of this organization' using errcode = '23505';
  end if;

  update public.organization_invitations
  set status = 'accepted', accepted_by = v_user, accepted_at = now()
  where id = v_invitation.id;

  return v_invitation.organization_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- decide_approval: the approver confirms the payload fingerprint they
-- reviewed. If the proposed action changed, the decision is refused.
-- ---------------------------------------------------------------------------

create function public.decide_approval(
  p_request_id uuid,
  p_decision text,
  p_payload_sha256 text,
  p_note text default null
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.approval_requests;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;

  select * into v_request from public.approval_requests as a where a.id = p_request_id for update;

  if v_request.id is null or not private.has_min_role(v_request.organization_id, v_request.required_role) then
    raise exception 'approval request not found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'approval request is already %', v_request.status using errcode = '55000';
  end if;
  if v_request.expires_at <= now() then
    update public.approval_requests set status = 'expired', decided_at = now()
    where id = v_request.id returning * into v_request;
    update public.tool_executions set status = 'cancelled'
    where id = v_request.tool_execution_id and status = 'awaiting_approval';
    return v_request;
  end if;
  if p_payload_sha256 is distinct from v_request.payload_sha256 then
    raise exception 'the proposed action changed after you reviewed it; review it again' using errcode = '40001';
  end if;

  update public.approval_requests
  set status = p_decision, decided_by = v_user, decided_at = now(), decision_note = p_note
  where id = v_request.id
  returning * into v_request;

  update public.tool_executions
  set status = p_decision
  where id = v_request.tool_execution_id and status = 'awaiting_approval';

  return v_request;
end;
$$;

revoke all on function
  public.create_organization(text, text),
  public.create_invitation(uuid, text, text, interval),
  public.accept_invitation(text),
  public.decide_approval(uuid, text, text, text)
from public, anon;

grant execute on function
  public.create_organization(text, text),
  public.create_invitation(uuid, text, text, interval),
  public.accept_invitation(text),
  public.decide_approval(uuid, text, text, text)
to authenticated;

-- A minimal stand-in for the parts of Supabase the migrations and pgTAP tests
-- use, so they can run against a plain local PostgreSQL (16+) with the
-- pgvector, pgTAP and plpython3u packages installed. See scripts/db/local-test.sh.
--
-- This is NOT Supabase: Auth, Storage and PostgREST are reduced to the tables,
-- roles and functions the schema references. A pass here is evidence about our
-- SQL, not about the hosted platform; the hosted dev project stays the
-- reference (docs/testing-strategy.md).

-- Roles PostgREST switches to. service_role bypasses RLS, as on Supabase.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end
$$;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

-- Supabase's default privileges: new objects in public are granted to the API
-- roles, which is why the migrations revoke explicitly.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- pg_jsonschema: the migrations create it; scripts/db/local-test.sh installs
-- the stand-in extension from supabase/local/pg_jsonschema--0.0.1.sql.
create extension if not exists plpython3u;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

-- Auth: the users table columns the fixtures insert, and the JWT helpers.
create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_anonymous boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Storage: buckets, objects (RLS on, as on Supabase), the folder helper, and
-- the guard against deleting objects with plain SQL.
create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  version text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;

create or replace function storage.protect_delete() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('storage.allow_delete_query', true), 'false') <> 'true' then
    raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
      using errcode = '42501';
  end if;
  return null;
end
$$;
create trigger protect_objects_delete before delete on storage.objects
  for each statement execute function storage.protect_delete();
grant execute on all functions in schema storage to anon, authenticated, service_role;

-- Supabase's default search path.
do $$ begin execute format('alter database %I set search_path = "$user", public, extensions', current_database()); end $$;

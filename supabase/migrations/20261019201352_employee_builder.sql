-- Employee builder: the lifecycle (draft → testing → active ⇄ paused →
-- archived), configuration schema version 2 (every field an employee is
-- reviewed on), test cases and test runs, and the built-in skills catalog
-- limited to tools that exist.
--
-- Two versions matter for an employee: current_version_id is the latest saved
-- configuration (what you edit and test); active_version_id is the version an
-- admin activated after its tests passed (what runs). Saving a new version
-- never changes what an active employee runs until it is activated too.
--
-- "Testing" is a draft under test: status stays 'draft' (so the existing
-- status check is unchanged) and testing_started_at is set; the generated
-- lifecycle_status column reports the five states the application shows
-- (draft, testing, active, paused, archived).
--
-- Status changes and activation go through change_employee_status (role,
-- transition, typed confirmation and test results are checked in SQL);
-- clients can no longer write status or version pointers directly.

-- ---------------------------------------------------------------------------
-- 1. Lifecycle columns
-- ---------------------------------------------------------------------------

alter table public.ai_employees
  add column testing_started_at timestamptz,
  add column active_version_id uuid,
  add column template_key text check (template_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  add column activated_at timestamptz,
  add column activated_by uuid references auth.users (id) on delete set null,
  add constraint ai_employees_active_version_fk
    foreign key (active_version_id, id) references public.employee_versions (id, employee_id),
  -- Only an activated version can run.
  add constraint ai_employees_running_has_active_version
    check (status not in ('active', 'paused') or (active_version_id is not null and activated_at is not null)),
  add constraint ai_employees_testing_is_a_saved_draft
    check (testing_started_at is null or (status = 'draft' and current_version_id is not null));

alter table public.ai_employees
  add column lifecycle_status text not null
    generated always as (case when status = 'draft' and testing_started_at is not null then 'testing' else status end) stored;

create index ai_employees_active_version_idx on public.ai_employees (active_version_id)
  where active_version_id is not null;
create index ai_employees_activated_by_idx on public.ai_employees (activated_by)
  where activated_by is not null;

-- ---------------------------------------------------------------------------
-- 2. Configuration schema version 2
--
-- Version 1 is unchanged (existing rows stay valid). Version 2 holds the full
-- reviewed configuration; instructions stay in employee_versions.instructions.
-- The application validates the same shape with Zod
-- (src/modules/employees/domain/schemas.ts) plus semantic checks (tools exist,
-- connections belong to the organization) before saving.
-- ---------------------------------------------------------------------------

create or replace function private.employee_config_is_valid(p_schema_version integer, p_config jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_schema_version
    when 1 then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "required": ["modelTier", "limits"],
        "properties": {
          "modelTier": { "enum": ["fast", "balanced", "deep"] },
          "model": { "type": "string", "minLength": 1, "maxLength": 100 },
          "channels": {
            "type": "array",
            "uniqueItems": true,
            "items": { "enum": ["chat", "workflow", "email", "voice"] }
          },
          "limits": {
            "type": "object",
            "additionalProperties": false,
            "required": ["maxTurnsPerTask", "maxToolCallsPerTask", "maxCostUsdPerTask"],
            "properties": {
              "maxTurnsPerTask": { "type": "integer", "minimum": 1, "maximum": 200 },
              "maxToolCallsPerTask": { "type": "integer", "minimum": 0, "maximum": 500 },
              "maxCostUsdPerTask": { "type": "number", "exclusiveMinimum": 0, "maximum": 1000 }
            }
          },
          "outputStyle": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "language": { "type": "string", "minLength": 2, "maxLength": 35 },
              "format": { "enum": ["plain", "markdown"] }
            }
          },
          "knowledge": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "maxChunks": { "type": "integer", "minimum": 0, "maximum": 50 }
            }
          }
        }
      }$schema$::json,
      p_config
    )
    when 2 then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "required": [
          "profile", "responsibilities", "skills", "tools", "knowledge", "model", "successCriteria",
          "allowedActions", "prohibitedActions", "escalation", "limits", "budget"
        ],
        "properties": {
          "profile": {
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "department", "description"],
            "properties": {
              "name": { "type": "string", "minLength": 1, "maxLength": 120 },
              "department": {
                "enum": [
                  "voice", "sales", "marketing", "support", "analytics", "operations",
                  "executive_assistant", "finance_admin", "hr_admin", "research", "custom"
                ]
              },
              "description": { "type": "string", "maxLength": 2000 },
              "templateKey": { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,63}$" }
            }
          },
          "responsibilities": {
            "type": "array", "minItems": 1, "maxItems": 20,
            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
          },
          "skills": {
            "type": "array", "maxItems": 20, "uniqueItems": true,
            "items": { "type": "string", "pattern": "^[a-z][a-z0-9_.-]{1,63}$" }
          },
          "tools": {
            "type": "array", "maxItems": 30,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["toolKey", "integrationId", "approval"],
              "properties": {
                "toolKey": { "type": "string", "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" },
                "integrationId": {
                  "anyOf": [
                    { "type": "null" },
                    { "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }
                  ]
                },
                "approval": { "enum": ["allow", "require_approval"] }
              }
            }
          },
          "knowledge": {
            "type": "object",
            "additionalProperties": false,
            "required": ["access", "sourceIds", "maxPassages"],
            "properties": {
              "access": { "enum": ["none", "all", "selected"] },
              "sourceIds": {
                "type": "array", "maxItems": 50, "uniqueItems": true,
                "items": { "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }
              },
              "maxPassages": { "type": "integer", "minimum": 1, "maximum": 20 }
            }
          },
          "model": {
            "type": "object",
            "additionalProperties": false,
            "required": ["provider", "tier", "effort", "maxOutputTokens"],
            "properties": {
              "provider": { "enum": ["anthropic"] },
              "tier": { "enum": ["fast", "balanced", "deep"] },
              "effort": { "enum": ["low", "medium", "high"] },
              "maxOutputTokens": { "type": "integer", "minimum": 1024, "maximum": 32000 }
            }
          },
          "successCriteria": {
            "type": "array", "minItems": 1, "maxItems": 10,
            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
          },
          "allowedActions": {
            "type": "array", "maxItems": 20,
            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
          },
          "prohibitedActions": {
            "type": "array", "maxItems": 20,
            "items": { "type": "string", "minLength": 1, "maxLength": 300 }
          },
          "escalation": {
            "type": "object",
            "additionalProperties": false,
            "required": ["when", "behavior", "notes"],
            "properties": {
              "when": {
                "type": "array", "maxItems": 10,
                "items": { "type": "string", "minLength": 1, "maxLength": 300 }
              },
              "behavior": { "enum": ["stop_and_report", "ask_requester"] },
              "notes": { "type": "string", "maxLength": 1000 }
            }
          },
          "limits": {
            "type": "object",
            "additionalProperties": false,
            "required": ["maxTurnsPerTask", "maxToolCallsPerTask", "maxCostUsdPerTask", "maxRuntimeSeconds"],
            "properties": {
              "maxTurnsPerTask": { "type": "integer", "minimum": 1, "maximum": 50 },
              "maxToolCallsPerTask": { "type": "integer", "minimum": 0, "maximum": 100 },
              "maxCostUsdPerTask": { "type": "number", "exclusiveMinimum": 0, "maximum": 50 },
              "maxRuntimeSeconds": { "type": "integer", "minimum": 10, "maximum": 900 }
            }
          },
          "budget": {
            "type": "object",
            "additionalProperties": false,
            "required": ["monthlyUsd"],
            "properties": {
              "monthlyUsd": { "type": "number", "exclusiveMinimum": 0, "maximum": 10000 }
            }
          },
          "outputStyle": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "language": { "type": "string", "minLength": 2, "maxLength": 35 },
              "format": { "enum": ["plain", "markdown"] }
            }
          }
        }
      }$schema$::json,
      p_config
    )
    -- A tool is granted at most once, and "selected" knowledge names sources.
    and (
      select count(*) = count(distinct t.value ->> 'toolKey')
      from jsonb_array_elements(p_config -> 'tools') as t
    )
    and (
      p_config -> 'knowledge' ->> 'access' <> 'selected'
      or jsonb_array_length(p_config -> 'knowledge' -> 'sourceIds') > 0
    )
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Saving a version updates the employee
--
-- The newest version becomes current_version_id, and the profile in a
-- version 2 configuration is copied to the employee row (so name, department
-- and description have history too). Archived employees can't be edited.
-- ---------------------------------------------------------------------------

create function private.apply_employee_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select e.status into v_status
  from public.ai_employees as e
  where e.id = new.employee_id and e.organization_id = new.organization_id
  for update;

  if v_status = 'archived' then
    raise exception 'archived employees cannot be edited; restore it first' using errcode = '55000';
  end if;

  update public.ai_employees as e
  set current_version_id = new.id,
      name = case when new.config_schema_version = 2 then btrim(new.config -> 'profile' ->> 'name') else e.name end,
      role_category = case when new.config_schema_version = 2 then new.config -> 'profile' ->> 'department' else e.role_category end,
      description = case when new.config_schema_version = 2 then nullif(btrim(new.config -> 'profile' ->> 'description'), '') else e.description end
  where e.id = new.employee_id and e.organization_id = new.organization_id;
  return null;
end;
$$;

create trigger apply_employee_version after insert on public.employee_versions
  for each row execute function private.apply_employee_version();

-- ---------------------------------------------------------------------------
-- 4. Test cases and test runs
-- ---------------------------------------------------------------------------

create table public.employee_test_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  input text not null
    check (char_length(btrim(input)) between 1 and 4000 and not private.text_contains_secret(input)),
  -- Checks applied automatically to each run's trace.
  expectations jsonb not null default '{}'::jsonb
    check (
      extensions.jsonb_matches_schema(
        $schema${
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "mustUseTools": { "type": "array", "maxItems": 10, "items": { "type": "string", "maxLength": 100 } },
            "mustNotUseTools": { "type": "array", "maxItems": 10, "items": { "type": "string", "maxLength": 100 } },
            "mustRequestApproval": { "type": "array", "maxItems": 10, "items": { "type": "string", "maxLength": 100 } },
            "replyMustMention": { "type": "array", "maxItems": 10, "items": { "type": "string", "minLength": 1, "maxLength": 200 } },
            "mustEscalate": { "type": "boolean" }
          }
        }$schema$::json,
        expectations
      )
      and not private.jsonb_contains_secret(expectations)
    ),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete cascade,
  unique (id, organization_id),
  unique (id, employee_id),
  unique (employee_id, name)
);

create index employee_test_cases_org_idx on public.employee_test_cases (organization_id);

create table public.employee_test_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  version_id uuid not null,
  -- NULL: a free-form playground run (passes only when a reviewer says so).
  test_case_id uuid,
  input text not null check (char_length(btrim(input)) between 1 and 4000),
  result text not null default 'running'
    check (result in ('running', 'passed', 'failed', 'needs_review', 'error')),
  -- How the run ended (completed, limit_reached, escalated, refused, error).
  outcome text check (outcome in ('completed', 'limit_reached', 'escalated', 'refused', 'error')),
  reply text check (char_length(reply) <= 20000 and not private.text_contains_secret(reply)),
  -- Messages and tool calls (redacted), and the automatic checks.
  transcript jsonb not null default '[]'::jsonb
    check (jsonb_typeof(transcript) = 'array' and not private.jsonb_contains_secret(transcript)),
  checks jsonb not null default '[]'::jsonb
    check (jsonb_typeof(checks) = 'array' and not private.jsonb_contains_secret(checks)),
  model text check (char_length(model) <= 100),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  error jsonb check (error is null or (jsonb_typeof(error) = 'object' and not private.jsonb_contains_secret(error))),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 1000),
  created_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete cascade,
  foreign key (version_id, employee_id)
    references public.employee_versions (id, employee_id) on delete cascade,
  foreign key (test_case_id, employee_id)
    references public.employee_test_cases (id, employee_id) on delete set null (test_case_id),
  unique (id, organization_id),
  check ((result = 'running') = (finished_at is null)),
  check (finished_at is null or finished_at >= started_at),
  check (result <> 'error' or error is not null),
  check ((reviewed_by is null) = (reviewed_at is null))
);

create index employee_test_runs_org_idx on public.employee_test_runs (organization_id, created_at desc);
create index employee_test_runs_employee_idx on public.employee_test_runs (employee_id, created_at desc);
create index employee_test_runs_version_idx on public.employee_test_runs (version_id, test_case_id, created_at desc);
create index employee_test_runs_case_idx on public.employee_test_runs (test_case_id) where test_case_id is not null;

create trigger set_updated_at before update on public.employee_test_cases
  for each row execute function private.set_updated_at();

-- A version's test status:
--   untested      no finished run on this version
--   incomplete    a saved test case hasn't been run on this version
--   failed        the latest run of a saved test case (or the latest free-form
--                 run) failed or errored
--   needs_review  such a latest run is waiting for a reviewer, and nothing failed
--   passed        every saved test case's latest run passed (and at least one run passed)
create function private.employee_version_test_status(p_version_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  with version as (
    select v.id, v.employee_id from public.employee_versions as v where v.id = p_version_id
  ),
  finished as (
    select r.* from public.employee_test_runs as r
    where r.version_id = p_version_id and r.result <> 'running'
  ),
  latest as (
    select distinct on (f.test_case_id) f.test_case_id, f.result
    from finished as f
    where f.test_case_id is not null
    order by f.test_case_id, f.created_at desc, f.id desc
  ),
  latest_free_form as (
    select f.result from finished as f
    where f.test_case_id is null
    order by f.created_at desc, f.id desc
    limit 1
  ),
  cases as (
    select c.id from public.employee_test_cases as c join version as v on c.employee_id = v.employee_id
  )
  select case
    when not exists (select 1 from finished) then 'untested'
    when exists (select 1 from cases as c where not exists (select 1 from latest as l where l.test_case_id = c.id)) then 'incomplete'
    when exists (select 1 from latest as l where l.result in ('failed', 'error'))
      or exists (select 1 from latest_free_form as l where l.result in ('failed', 'error')) then 'failed'
    when exists (select 1 from latest as l where l.result = 'needs_review')
      or exists (select 1 from latest_free_form as l where l.result = 'needs_review')
      or not exists (select 1 from finished as f where f.result = 'passed') then 'needs_review'
    else 'passed'
  end;
$$;

-- Per-version test summary for the employee pages (runs under RLS).
create function public.employee_test_summary(p_employee_id uuid)
returns table (version_id uuid, test_status text, passed_runs bigint, failed_runs bigint, last_run_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    v.id,
    private.employee_version_test_status(v.id),
    count(r.id) filter (where r.result = 'passed'),
    count(r.id) filter (where r.result in ('failed', 'error')),
    max(r.created_at)
  from public.employee_versions as v
  left join public.employee_test_runs as r on r.version_id = v.id
  where v.employee_id = p_employee_id
  group by v.id;
$$;

-- ---------------------------------------------------------------------------
-- 5. Creating and editing (under the caller's session and RLS)
-- ---------------------------------------------------------------------------

create function public.create_employee(
  p_organization_id uuid,
  p_instructions text,
  p_config jsonb,
  p_change_note text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.ai_employees (organization_id, name, role_category, description, template_key)
  values (
    p_organization_id,
    btrim(p_config -> 'profile' ->> 'name'),
    p_config -> 'profile' ->> 'department',
    nullif(btrim(p_config -> 'profile' ->> 'description'), ''),
    p_config -> 'profile' ->> 'templateKey'
  )
  returning id into v_id;

  insert into public.employee_versions (organization_id, employee_id, instructions, config_schema_version, config, change_note)
  values (p_organization_id, v_id, p_instructions, 2, p_config, p_change_note);
  return v_id;
end;
$$;

-- Saves a new version. p_based_on_version_id is the version the editor
-- started from; if someone saved in between, nothing is saved (40001).
create function public.save_employee_version(
  p_employee_id uuid,
  p_based_on_version_id uuid,
  p_instructions text,
  p_config jsonb,
  p_change_note text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_employee public.ai_employees%rowtype;
  v_version public.employee_versions%rowtype;
begin
  select * into v_employee from public.ai_employees as e where e.id = p_employee_id for update;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if v_employee.current_version_id is distinct from p_based_on_version_id then
    raise exception 'the employee was changed by someone else' using errcode = '40001';
  end if;

  insert into public.employee_versions (organization_id, employee_id, instructions, config_schema_version, config, change_note)
  values (v_employee.organization_id, v_employee.id, p_instructions, 2, p_config, p_change_note)
  returning * into v_version;
  return jsonb_build_object('version_id', v_version.id, 'version', v_version.version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Status changes
--
--   start_testing    draft → testing                      operator
--   return_to_draft  testing → draft                      operator
--   activate         draft | testing | active | paused → active   admin
--                    (p_version_id must be the current version, its tests
--                    must have passed, and p_confirm_name must repeat the
--                    employee's name; grants are synced from that version)
--   pause            active → paused                      operator
--   resume           paused → active                      admin (active version's tests still pass)
--   archive          any → archived                       admin
--   restore          archived → draft                     admin
--
-- Errors: P0002 not found / role too low, 55000 transition not allowed,
-- 40001 not the current version, 22023 confirmation mismatch, 23514 tests
-- haven't passed.
-- ---------------------------------------------------------------------------

create function public.change_employee_status(
  p_employee_id uuid,
  p_action text,
  p_version_id uuid default null,
  p_confirm_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_employee public.ai_employees%rowtype;
  v_version public.employee_versions%rowtype;
  v_min_role text;
  v_test_status text;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  v_min_role := case when p_action in ('start_testing', 'return_to_draft', 'pause') then 'operator' else 'admin' end;
  select * into v_employee from public.ai_employees as e where e.id = p_employee_id for update;
  if not found or not private.has_min_role(v_employee.organization_id, v_min_role) then
    raise exception 'employee not found or role too low' using errcode = 'P0002';
  end if;

  case p_action
    when 'start_testing' then
      if v_employee.lifecycle_status <> 'draft' or v_employee.current_version_id is null then
        raise exception 'only a saved draft can move to testing' using errcode = '55000';
      end if;
      update public.ai_employees set testing_started_at = now() where id = v_employee.id;

    when 'return_to_draft' then
      if v_employee.lifecycle_status <> 'testing' then
        raise exception 'only an employee in testing can return to draft' using errcode = '55000';
      end if;
      update public.ai_employees set testing_started_at = null where id = v_employee.id;

    when 'activate' then
      if v_employee.status = 'archived' then
        raise exception 'restore the employee before activating it' using errcode = '55000';
      end if;
      if p_version_id is null or p_version_id is distinct from v_employee.current_version_id then
        raise exception 'only the latest saved version can be activated' using errcode = '40001';
      end if;
      if p_confirm_name is null or lower(btrim(p_confirm_name)) <> lower(btrim(v_employee.name)) then
        raise exception 'type the employee''s name to confirm' using errcode = '22023';
      end if;
      select * into v_version from public.employee_versions as v
      where v.id = p_version_id and v.employee_id = v_employee.id;
      if v_version.config_schema_version <> 2 then
        raise exception 'this version uses an old configuration format; save it again first' using errcode = '55000';
      end if;
      v_test_status := private.employee_version_test_status(p_version_id);
      if v_test_status <> 'passed' then
        raise exception 'tests have not passed for this version (status: %)', v_test_status using errcode = '23514';
      end if;

      update public.ai_employees
      set status = 'active', testing_started_at = null, active_version_id = p_version_id,
          activated_at = now(), activated_by = v_uid
      where id = v_employee.id;

      -- Grants follow the activated version exactly.
      delete from public.employee_tool_permissions as p
      where p.employee_id = v_employee.id and p.organization_id = v_employee.organization_id;
      insert into public.employee_tool_permissions (organization_id, employee_id, tool_key, integration_id, decision, granted_by)
      select v_employee.organization_id, v_employee.id, t.value ->> 'toolKey', (t.value ->> 'integrationId')::uuid,
        t.value ->> 'approval', v_uid
      from jsonb_array_elements(v_version.config -> 'tools') as t;

      delete from public.employee_skills as s
      where s.employee_id = v_employee.id and s.organization_id = v_employee.organization_id;
      insert into public.employee_skills (organization_id, employee_id, skill_id)
      select v_employee.organization_id, v_employee.id, s.id
      from public.skills as s
      where s.key in (select jsonb_array_elements_text(v_version.config -> 'skills'))
        and s.status = 'active'
        and (s.organization_id is null or s.organization_id = v_employee.organization_id);

      insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, target_table, target_id, metadata)
      values (v_employee.organization_id, 'user', v_uid, 'employee.activated', 'ai_employees', v_employee.id::text,
        jsonb_build_object('version', v_version.version, 'version_id', v_version.id,
          'tools', (select coalesce(jsonb_agg(t.value ->> 'toolKey'), '[]'::jsonb) from jsonb_array_elements(v_version.config -> 'tools') as t)));

    when 'pause' then
      if v_employee.status <> 'active' then
        raise exception 'only an active employee can be paused' using errcode = '55000';
      end if;
      update public.ai_employees set status = 'paused' where id = v_employee.id;

    when 'resume' then
      if v_employee.status <> 'paused' then
        raise exception 'only a paused employee can be resumed' using errcode = '55000';
      end if;
      v_test_status := private.employee_version_test_status(v_employee.active_version_id);
      if v_test_status <> 'passed' then
        raise exception 'tests no longer pass for the active version (status: %)', v_test_status using errcode = '23514';
      end if;
      update public.ai_employees set status = 'active' where id = v_employee.id;

    when 'archive' then
      if v_employee.status = 'archived' then
        raise exception 'already archived' using errcode = '55000';
      end if;
      update public.ai_employees set status = 'archived', testing_started_at = null where id = v_employee.id;

    when 'restore' then
      if v_employee.status <> 'archived' then
        raise exception 'only an archived employee can be restored' using errcode = '55000';
      end if;
      update public.ai_employees set status = 'draft', active_version_id = null where id = v_employee.id;

    else
      raise exception 'unknown action %', p_action using errcode = '22023';
  end case;

  select * into v_employee from public.ai_employees as e where e.id = p_employee_id;
  return jsonb_build_object('status', v_employee.lifecycle_status, 'active_version_id', v_employee.active_version_id);
end;
$$;

-- A reviewer's verdict on a test run: a run waiting for review can be passed
-- or failed; an automatically passed run can be failed. Failed and errored
-- runs can't be overturned (run the test again instead).
create function public.review_employee_test_run(p_run_id uuid, p_verdict text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_run public.employee_test_runs%rowtype;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_verdict not in ('passed', 'failed') then
    raise exception 'verdict must be passed or failed' using errcode = '22023';
  end if;

  select * into v_run from public.employee_test_runs as r where r.id = p_run_id for update;
  if not found or not private.has_min_role(v_run.organization_id, 'operator') then
    raise exception 'test run not found or role too low' using errcode = 'P0002';
  end if;
  if not (v_run.result = 'needs_review' or (v_run.result = 'passed' and p_verdict = 'failed')) then
    raise exception 'this run can''t be reviewed (result: %)', v_run.result using errcode = '55000';
  end if;

  update public.employee_test_runs
  set result = p_verdict, reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(btrim(p_note), '')
  where id = v_run.id;
  return p_verdict;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges and Row Level Security
-- ---------------------------------------------------------------------------

-- Status, version pointers and the profile change only through the functions
-- above (the profile through versions, so it has history).
revoke update on public.ai_employees from authenticated;
grant update (avatar_url) on public.ai_employees to authenticated;
revoke insert on public.ai_employees from authenticated;
grant insert (organization_id, name, role_category, description, avatar_url, template_key) on public.ai_employees to authenticated;

-- Only drafts that were never activated can be deleted; others are archived.
-- (Restrictive: narrows the existing "operators delete" policy.)
create policy "ai_employees: only unactivated drafts are deleted" on public.ai_employees
  as restrictive
  for delete to authenticated
  using (status = 'draft' and activated_at is null);

alter table public.employee_test_cases enable row level security;
alter table public.employee_test_runs enable row level security;
revoke all on public.employee_test_cases, public.employee_test_runs from anon, authenticated;

grant select, delete on public.employee_test_cases to authenticated;
grant insert (organization_id, employee_id, name, input, expectations) on public.employee_test_cases to authenticated;
grant update (name, input, expectations) on public.employee_test_cases to authenticated;

create policy "employee_test_cases: members read" on public.employee_test_cases
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));
create policy "employee_test_cases: operators create" on public.employee_test_cases
  for insert to authenticated
  with check (organization_id in (select private.org_ids_with_min_role('operator')));
create policy "employee_test_cases: operators update" on public.employee_test_cases
  for update to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')))
  with check (organization_id in (select private.org_ids_with_min_role('operator')));
create policy "employee_test_cases: operators delete" on public.employee_test_cases
  for delete to authenticated
  using (organization_id in (select private.org_ids_with_min_role('operator')));

-- Test runs are written by the server (service role) after it checks the
-- caller's role; members read them.
grant select on public.employee_test_runs to authenticated;
create policy "employee_test_runs: members read" on public.employee_test_runs
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

revoke all on function
  public.create_employee(uuid, text, jsonb, text),
  public.save_employee_version(uuid, uuid, text, jsonb, text),
  public.change_employee_status(uuid, text, uuid, text),
  public.review_employee_test_run(uuid, text, text),
  public.employee_test_summary(uuid),
  private.employee_version_test_status(uuid),
  private.apply_employee_version()
from public, anon;
grant execute on function
  public.create_employee(uuid, text, jsonb, text),
  public.save_employee_version(uuid, uuid, text, jsonb, text),
  public.change_employee_status(uuid, text, uuid, text),
  public.review_employee_test_run(uuid, text, text),
  public.employee_test_summary(uuid),
  private.employee_version_test_status(uuid)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Built-in skills: only tools that exist
--
-- Gmail and Calendar connectors are not built, so their skills are retired;
-- CRM and chat skills list the actions the HubSpot and Slack connectors have.
-- ---------------------------------------------------------------------------

update public.skills set status = 'deprecated'
where organization_id is null and key in ('email.correspondence', 'calendar.scheduling');

update public.skills
set tool_keys = '{hubspot.contacts.search,hubspot.contacts.upsert,hubspot.notes.create}',
    description = 'Find contacts in HubSpot, create or update them, and add notes.'
where organization_id is null and key = 'crm.records';

update public.skills
set tool_keys = '{slack.channels.list,slack.messages.post}',
    description = 'List Slack channels and post messages to them.'
where organization_id is null and key = 'chat.messaging';

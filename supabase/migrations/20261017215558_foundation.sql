-- Nexefiy foundation: extensions, the private schema, and shared helpers.
--
-- Conventions used by every later migration (see docs/database-design.md):
-- * Tenant tables carry organization_id and expose UNIQUE (id, organization_id)
--   so children reference parents with composite foreign keys. A row can then
--   never point at another organization's data, whatever the client sends.
-- * RLS is enabled on every table in public. Privileges are granted explicitly
--   per table after revoking Supabase's default grants.
-- * Helper and trigger functions live in `private`, which the Data API does not
--   expose. SECURITY DEFINER functions always pin search_path = ''.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_jsonschema with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Functions are executable by PUBLIC by default; every private function must
-- be granted explicitly.
alter default privileges in schema private revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Timestamps
-- ---------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Records the acting user in updated_by (works for any table with that column).
create function private.stamp_updated_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new := jsonb_populate_record(new, jsonb_build_object('updated_by', (select auth.uid())));
  end if;
  return new;
end;
$$;

create function private.prevent_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are immutable; create a new row instead', tg_table_name
    using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- Roles: owner > admin > operator > viewer
-- ---------------------------------------------------------------------------

create function private.role_rank(p_role text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'owner' then 4
    when 'admin' then 3
    when 'operator' then 2
    when 'viewer' then 1
    else 0
  end;
$$;

-- ---------------------------------------------------------------------------
-- Secret detection for JSON columns
--
-- Raw provider credentials must never be stored in configuration JSON. Keys
-- that name a credential, and string values shaped like known credentials or
-- like an encrypted credential envelope, are rejected anywhere in the document.
-- ---------------------------------------------------------------------------

create function private.jsonb_contains_secret(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null and (
    jsonb_path_exists(
      p_value,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(password|passwd|secret|token|client_?secret|signing_?secret|webhook_?secret|api_?key|apikey|access_?token|refresh_?token|id_?token|private_?key|bearer|authorization)$" flag "i")'
    )
    or jsonb_path_exists(
      p_value,
      '$.** ? (@.type() == "string" && @ like_regex "(^|[^A-Za-z0-9_])(sk-ant-|sk-proj-|sk_live_|sk_test_|rk_live_|rk_test_|sb_secret_|whsec_|xox[abpr]-|GOCSPX-|ya29\\.|nxf1\\.)")'
    )
  );
$$;

create function private.text_contains_secret(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value ~ '(^|[^A-Za-z0-9_])(sk-ant-|sk-proj-|sk_live_|sk_test_|rk_live_|rk_test_|sb_secret_|whsec_|xox[abpr]-|GOCSPX-|ya29\.|nxf1\.)';
$$;

-- ---------------------------------------------------------------------------
-- Versioned JSON schemas
--
-- Each validator dispatches on a schema version. To evolve a format, add a new
-- branch (never edit an existing one) so stored rows stay valid.
-- ---------------------------------------------------------------------------

create function private.employee_config_is_valid(p_schema_version integer, p_config jsonb)
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
    else false
  end;
$$;

create function private.workflow_graph_is_valid(p_schema_version integer, p_graph jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_schema_version <> 1 then false
    when not extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "required": ["nodes", "edges"],
        "properties": {
          "nodes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 200,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "type"],
              "properties": {
                "id": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
                "type": { "enum": ["employee_task", "tool_action", "condition", "approval", "delay"] },
                "label": { "type": "string", "maxLength": 200 },
                "config": { "type": "object" }
              }
            }
          },
          "edges": {
            "type": "array",
            "maxItems": 500,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["source", "target"],
              "properties": {
                "id": { "type": "string", "maxLength": 64 },
                "source": { "type": "string" },
                "target": { "type": "string" },
                "condition": { "enum": ["true", "false", "approved", "rejected", "expired"] }
              }
            }
          },
          "settings": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "maxRunMinutes": { "type": "integer", "minimum": 1, "maximum": 10080 },
              "maxCostUsd": { "type": "number", "exclusiveMinimum": 0 },
              "onFailure": { "enum": ["stop", "notify"] }
            }
          }
        }
      }$schema$::json,
      p_graph
    ) then false
    -- Node ids are unique and every edge connects existing nodes.
    else (
      select count(*) = count(distinct n.value ->> 'id')
      from jsonb_array_elements(p_graph -> 'nodes') as n
    ) and not exists (
      select 1
      from jsonb_array_elements(p_graph -> 'edges') as e
      where not exists (select 1 from jsonb_array_elements(p_graph -> 'nodes') as n where n.value ->> 'id' = e.value ->> 'source')
         or not exists (select 1 from jsonb_array_elements(p_graph -> 'nodes') as n where n.value ->> 'id' = e.value ->> 'target')
    )
  end;
$$;

create function private.policy_document_is_valid(p_schema_version integer, p_policy jsonb)
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
        "required": ["rules"],
        "properties": {
          "rules": {
            "type": "array",
            "maxItems": 500,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["effect"],
              "properties": {
                "id": { "type": "string", "maxLength": 64 },
                "description": { "type": "string", "maxLength": 500 },
                "effect": { "enum": ["allow", "require_approval", "deny"] },
                "toolKeys": { "type": "array", "items": { "type": "string", "maxLength": 100 } },
                "riskLevels": {
                  "type": "array",
                  "items": { "enum": ["read", "write_internal", "write_external", "sensitive"] }
                },
                "employeeIds": { "type": "array", "items": { "type": "string", "maxLength": 36 } },
                "conditions": { "type": "object" }
              }
            }
          },
          "defaults": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "approvalExpiresInHours": { "type": "integer", "minimum": 1, "maximum": 720 }
            }
          }
        }
      }$schema$::json,
      p_policy
    )
    else false
  end;
$$;

create function private.sha256_hex(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex');
$$;

-- Check constraints call these with the privileges of the writing role.
grant execute on function
  private.role_rank(text),
  private.jsonb_contains_secret(jsonb),
  private.text_contains_secret(text),
  private.employee_config_is_valid(integer, jsonb),
  private.workflow_graph_is_valid(integer, jsonb),
  private.policy_document_is_valid(integer, jsonb),
  private.sha256_hex(text)
to authenticated, service_role;

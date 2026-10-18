-- Business context: the structured facts AI employees work from.
--
-- * company_settings.settings gains a versioned schema for the company
--   profile, operating hours and brand voice (the free-text columns legal_name,
--   industry, description, website, timezone and brand_voice already exist).
-- * business_context_items holds the list-shaped context: products and
--   services, target customers, goals and KPIs, departments, standard operating
--   procedures, escalation contacts, approved communication templates and
--   frequently asked questions. One table with a `kind`, because every kind is
--   a titled entry with a body and a few typed attributes; attributes are
--   validated per kind by a JSON schema.
--
-- Operators and above manage most kinds. Escalation contacts and communication
-- templates are admin-only: contacts decide where escalations (and the
-- information in them) are sent, and templates are the wording employees may
-- send outside the organization, so saving one is the approval.

-- ---------------------------------------------------------------------------
-- Company settings JSON (company profile, operating hours, brand voice)
-- ---------------------------------------------------------------------------

create function private.company_settings_is_valid(p_settings jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case coalesce(p_settings ->> 'schemaVersion', '1')
    when '1' then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "schemaVersion": { "const": 1 },
          "profile": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "headquarters": { "type": "string", "maxLength": 200 },
              "foundedYear": { "type": "integer", "minimum": 1800, "maximum": 2100 },
              "teamSize": { "enum": ["1", "2-10", "11-50", "51-200", "201-1000", "1000+"] },
              "serviceArea": { "type": "string", "maxLength": 500 },
              "languages": {
                "type": "array",
                "maxItems": 20,
                "uniqueItems": true,
                "items": { "type": "string", "minLength": 1, "maxLength": 60 }
              }
            }
          },
          "operatingHours": {
            "type": "object",
            "additionalProperties": false,
            "required": ["weekly"],
            "properties": {
              "weekly": {
                "type": "object",
                "additionalProperties": false,
                "patternProperties": {
                  "^(mon|tue|wed|thu|fri|sat|sun)$": {
                    "type": "array",
                    "maxItems": 3,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": ["open", "close"],
                      "properties": {
                        "open": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
                        "close": { "type": "string", "pattern": "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$" }
                      }
                    }
                  }
                }
              },
              "notes": { "type": "string", "maxLength": 1000 }
            }
          },
          "brandVoice": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "formality": { "enum": ["casual", "neutral", "formal"] },
              "tone": {
                "type": "array",
                "maxItems": 10,
                "uniqueItems": true,
                "items": { "type": "string", "minLength": 1, "maxLength": 40 }
              },
              "preferredPhrases": {
                "type": "array",
                "maxItems": 20,
                "items": { "type": "string", "minLength": 1, "maxLength": 200 }
              },
              "avoidPhrases": {
                "type": "array",
                "maxItems": 20,
                "items": { "type": "string", "minLength": 1, "maxLength": 200 }
              }
            }
          }
        }
      }$schema$::json,
      p_settings
    )
    else false
  end;
$$;

grant execute on function private.company_settings_is_valid(jsonb) to authenticated, service_role;

alter table public.company_settings
  add constraint company_settings_settings_valid check (private.company_settings_is_valid(settings));

-- ---------------------------------------------------------------------------
-- Business context items
-- ---------------------------------------------------------------------------

create function private.business_context_attributes_are_valid(p_kind text, p_attributes jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'product' then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "offeringType": { "enum": ["product", "service"] },
          "priceNote": { "type": "string", "maxLength": 200 },
          "url": { "type": "string", "pattern": "^https?://", "maxLength": 500 }
        }
      }$schema$::json, p_attributes)
    when 'customer_segment' then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "properties": { "priority": { "enum": ["primary", "secondary"] } }
      }$schema$::json, p_attributes)
    when 'goal' then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "metric": { "type": "string", "maxLength": 200 },
          "target": { "type": "string", "maxLength": 100 },
          "period": { "enum": ["weekly", "monthly", "quarterly", "yearly"] },
          "dueDate": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }
        }
      }$schema$::json, p_attributes)
    when 'department' then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "lead": { "type": "string", "maxLength": 200 },
          "email": { "type": "string", "pattern": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", "maxLength": 254 }
        }
      }$schema$::json, p_attributes)
    when 'sop' then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "trigger": { "type": "string", "maxLength": 500 },
          "department": { "type": "string", "maxLength": 200 }
        }
      }$schema$::json, p_attributes)
    when 'escalation_contact' then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "anyOf": [{ "required": ["email"] }, { "required": ["phone"] }],
        "properties": {
          "role": { "type": "string", "maxLength": 200 },
          "email": { "type": "string", "pattern": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", "maxLength": 254 },
          "phone": { "type": "string", "pattern": "^\\+?[0-9 ().-]{5,40}$" },
          "availability": { "type": "string", "maxLength": 300 },
          "priority": { "type": "integer", "minimum": 1, "maximum": 10 }
        }
      }$schema$::json, p_attributes)
    when 'template' then extensions.jsonb_matches_schema(
      $schema${
        "type": "object",
        "additionalProperties": false,
        "required": ["channel"],
        "properties": {
          "channel": { "enum": ["email", "sms", "chat", "voice"] },
          "subject": { "type": "string", "maxLength": 300 }
        }
      }$schema$::json, p_attributes)
    when 'faq' then extensions.jsonb_matches_schema(
      $schema${ "type": "object", "additionalProperties": false }$schema$::json, p_attributes)
    else false
  end;
$$;

grant execute on function private.business_context_attributes_are_valid(text, jsonb) to authenticated, service_role;

create table public.business_context_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('product', 'customer_segment', 'goal', 'department', 'sop',
    'escalation_contact', 'template', 'faq')),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  body text not null default '' check (char_length(body) <= 20000),
  attributes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(attributes) = 'object' and not private.jsonb_contains_secret(attributes)),
  position integer not null default 0 check (position between 0 and 100000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check (private.business_context_attributes_are_valid(kind, attributes)),
  -- An answer, a procedure and a template are meaningless without their text.
  check (kind not in ('faq', 'sop', 'template') or char_length(btrim(body)) > 0),
  check (not private.text_contains_secret(body))
);

create index business_context_items_org_kind_idx
  on public.business_context_items (organization_id, kind, status, position, created_at);

create trigger set_updated_at before update on public.business_context_items
  for each row execute function private.set_updated_at();
create trigger stamp_updated_by before update on public.business_context_items
  for each row execute function private.stamp_updated_by();
create trigger audit_row_change after insert or update or delete on public.business_context_items
  for each row execute function private.audit_row_change();

alter table public.business_context_items enable row level security;

revoke all on public.business_context_items from anon, authenticated;

grant select, delete on public.business_context_items to authenticated;
grant insert (organization_id, kind, title, body, attributes, position, status)
  on public.business_context_items to authenticated;
-- kind is fixed after creation, so an operator cannot turn an entry into an
-- admin-only kind.
grant update (title, body, attributes, position, status) on public.business_context_items to authenticated;

create policy "business_context_items: members read" on public.business_context_items
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

create policy "business_context_items: managers create" on public.business_context_items
  for insert to authenticated
  with check (
    (kind in ('escalation_contact', 'template')
      and organization_id in (select private.org_ids_with_min_role('admin')))
    or (kind not in ('escalation_contact', 'template')
      and organization_id in (select private.org_ids_with_min_role('operator')))
  );

create policy "business_context_items: managers update" on public.business_context_items
  for update to authenticated
  using (
    (kind in ('escalation_contact', 'template')
      and organization_id in (select private.org_ids_with_min_role('admin')))
    or (kind not in ('escalation_contact', 'template')
      and organization_id in (select private.org_ids_with_min_role('operator')))
  )
  with check (
    (kind in ('escalation_contact', 'template')
      and organization_id in (select private.org_ids_with_min_role('admin')))
    or (kind not in ('escalation_contact', 'template')
      and organization_id in (select private.org_ids_with_min_role('operator')))
  );

create policy "business_context_items: managers delete" on public.business_context_items
  for delete to authenticated
  using (
    (kind in ('escalation_contact', 'template')
      and organization_id in (select private.org_ids_with_min_role('admin')))
    or (kind not in ('escalation_contact', 'template')
      and organization_id in (select private.org_ids_with_min_role('operator')))
  );

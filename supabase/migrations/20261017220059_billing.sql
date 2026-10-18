-- Billing and outcomes: plans, entitlements, subscriptions, usage, outcomes,
-- and idempotency records for provider webhooks.
--
-- Money: subscription prices are integer minor units (cents) with an ISO 4217
-- currency code. Usage costs are integer micro-units (1/1,000,000 of the
-- currency unit) because model costs are fractions of a cent. No floats.

create table public.plans (
  plan_key text primary key check (plan_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  description text check (char_length(description) <= 1000),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  -- NULL = custom pricing or not yet decided.
  monthly_price_minor bigint check (monthly_price_minor >= 0),
  stripe_price_id text check (stripe_price_id ~ '^price_'),
  is_public boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.plan_entitlements (
  plan_key text not null references public.plans (plan_key) on update cascade on delete cascade,
  entitlement_key text not null check (entitlement_key ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  -- NULL limit with is_enabled = true means unlimited.
  limit_value bigint check (limit_value >= 0),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (plan_key, entitlement_key)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_key text not null references public.plans (plan_key) on update cascade,
  provider text not null default 'stripe' check (provider in ('stripe', 'manual')),
  provider_customer_id text check (char_length(provider_customer_id) <= 255),
  provider_subscription_id text unique check (char_length(provider_subscription_id) <= 255),
  status text not null check (status in (
    'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
  )),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  unit_amount_minor bigint check (unit_amount_minor >= 0),
  quantity integer not null default 1 check (quantity >= 1),
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_period_end is null or current_period_start is null or current_period_end > current_period_start),
  check (provider <> 'stripe' or (provider_customer_id is not null and provider_subscription_id is not null)),
  check ((status = 'canceled') = (canceled_at is not null))
);

-- At most one subscription per organization that still grants access.
create unique index subscriptions_one_live_idx on public.subscriptions (organization_id)
  where status in ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused');
create index subscriptions_org_idx on public.subscriptions (organization_id, created_at desc);

create table public.usage_records (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  metric text not null check (metric in (
    'task_completed', 'workflow_run', 'tool_execution', 'model_input_tokens', 'model_output_tokens',
    'model_cost', 'email_sent', 'embedding_tokens'
  )),
  quantity bigint not null check (quantity >= 0),
  cost_micros bigint check (cost_micros >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  provider text check (char_length(provider) <= 50),
  model text check (char_length(model) <= 100),
  task_id uuid,
  workflow_run_id uuid,
  employee_id uuid,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete set null (task_id),
  foreign key (workflow_run_id, organization_id)
    references public.workflow_runs (id, organization_id) on delete set null (workflow_run_id),
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete set null (employee_id),
  unique (organization_id, idempotency_key),
  check ((cost_micros is null) = (currency is null))
);

create index usage_records_org_metric_idx on public.usage_records (organization_id, metric, occurred_at desc);
create index usage_records_task_idx on public.usage_records (task_id) where task_id is not null;
create index usage_records_run_idx on public.usage_records (workflow_run_id) where workflow_run_id is not null;
create index usage_records_employee_idx on public.usage_records (employee_id) where employee_id is not null;

create table public.outcome_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  outcome_key text not null check (outcome_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  employee_id uuid,
  task_id uuid,
  workflow_run_id uuid,
  quantity numeric(20, 4) not null default 1 check (quantity >= 0),
  unit text check (char_length(unit) <= 32),
  -- Monetary outcomes (e.g. deal value) in minor units.
  value_minor bigint,
  currency text check (currency ~ '^[A-Z]{3}$'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and not private.jsonb_contains_secret(metadata)),
  idempotency_key text check (char_length(idempotency_key) between 1 and 200),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (employee_id, organization_id)
    references public.ai_employees (id, organization_id) on delete set null (employee_id),
  foreign key (task_id, organization_id) references public.tasks (id, organization_id) on delete set null (task_id),
  foreign key (workflow_run_id, organization_id)
    references public.workflow_runs (id, organization_id) on delete set null (workflow_run_id),
  unique (organization_id, idempotency_key),
  check ((value_minor is null) = (currency is null))
);

create index outcome_records_org_idx on public.outcome_records (organization_id, outcome_key, occurred_at desc);
create index outcome_records_employee_idx on public.outcome_records (employee_id) where employee_id is not null;
create index outcome_records_task_idx on public.outcome_records (task_id) where task_id is not null;
create index outcome_records_run_idx on public.outcome_records (workflow_run_id) where workflow_run_id is not null;

-- Idempotency for inbound provider webhooks (Stripe, Slack, HubSpot, Google…).
-- Stores a fingerprint, never the raw payload.
create table public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  event_id text not null check (char_length(event_id) between 1 and 255),
  event_type text not null check (char_length(event_type) between 1 and 255),
  organization_id uuid references public.organizations (id) on delete set null,
  status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (char_length(last_error) <= 2000),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (provider, event_id),
  check ((status in ('processed', 'ignored')) = (processed_at is not null))
);

create index provider_webhook_events_org_idx on public.provider_webhook_events (organization_id)
  where organization_id is not null;
create index provider_webhook_events_retry_idx on public.provider_webhook_events (provider, received_at)
  where status in ('received', 'failed');

create trigger set_updated_at before update on public.plans
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.plan_entitlements
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.subscriptions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.provider_webhook_events
  for each row execute function private.set_updated_at();
create trigger prevent_update before update on public.usage_records
  for each row execute function private.prevent_update();
create trigger audit_row_change after insert or update or delete on public.subscriptions
  for each row execute function private.audit_row_change();

-- Plan catalog. Prices are not decided yet (docs/billing-and-entitlements.md).
insert into public.plans (plan_key, name, description, monthly_price_minor) values
  ('trial', 'Trial', '14-day trial', 0),
  ('starter', 'Starter', 'For small teams getting started', null),
  ('growth', 'Growth', 'For growing teams', null),
  ('enterprise', 'Enterprise', 'Custom limits and support', null);

insert into public.plan_entitlements (plan_key, entitlement_key, limit_value, is_enabled) values
  ('trial', 'employees.max', 2, true),
  ('trial', 'workflows.active_max', 3, true),
  ('trial', 'tasks.monthly_max', 200, true),
  ('trial', 'integrations.max', 3, true),
  ('trial', 'members.max', 3, true),
  ('trial', 'triggers.schedule', null, true),
  ('trial', 'approvals.slack', null, false),
  ('trial', 'retention.task_events_days', 30, true),
  ('starter', 'employees.max', 3, true),
  ('starter', 'workflows.active_max', 10, true),
  ('starter', 'tasks.monthly_max', 1000, true),
  ('starter', 'integrations.max', 5, true),
  ('starter', 'members.max', 5, true),
  ('starter', 'triggers.schedule', null, true),
  ('starter', 'approvals.slack', null, false),
  ('starter', 'retention.task_events_days', 90, true),
  ('growth', 'employees.max', 10, true),
  ('growth', 'workflows.active_max', 50, true),
  ('growth', 'tasks.monthly_max', 5000, true),
  ('growth', 'integrations.max', null, true),
  ('growth', 'members.max', 20, true),
  ('growth', 'triggers.schedule', null, true),
  ('growth', 'approvals.slack', null, true),
  ('growth', 'retention.task_events_days', 180, true);

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- Plans are public catalog data. Subscriptions and usage are visible to
-- owners and admins only. Outcomes are visible to members (analytics).
-- All billing writes come from the server (Stripe webhooks, metering).
-- ---------------------------------------------------------------------------

alter table public.plans enable row level security;
alter table public.plan_entitlements enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_records enable row level security;
alter table public.outcome_records enable row level security;
alter table public.provider_webhook_events enable row level security;

revoke all on public.plans, public.plan_entitlements, public.subscriptions, public.usage_records,
  public.outcome_records, public.provider_webhook_events
from anon, authenticated;

grant select on public.plans, public.plan_entitlements to anon, authenticated;

create policy "plans: public plans readable" on public.plans
  for select to anon, authenticated
  using (is_public and is_active);

create policy "plan_entitlements: public plans readable" on public.plan_entitlements
  for select to anon, authenticated
  using (plan_key in (select p.plan_key from public.plans as p where p.is_public and p.is_active));

grant select on public.subscriptions, public.usage_records to authenticated;

create policy "subscriptions: admins read" on public.subscriptions
  for select to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

create policy "usage_records: admins read" on public.usage_records
  for select to authenticated
  using (organization_id in (select private.org_ids_with_min_role('admin')));

grant select on public.outcome_records to authenticated;

create policy "outcome_records: members read" on public.outcome_records
  for select to authenticated
  using (organization_id in (select private.member_org_ids()));

-- provider_webhook_events: service role only.
comment on table public.provider_webhook_events is
  'Idempotency records for inbound provider webhooks. Service role only.';

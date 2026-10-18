# Billing and Entitlements

## 1. Model

- Billing entity = **organization**. One Stripe Customer per org.
- Stripe Checkout for subscription start; Stripe Customer Portal for plan changes, payment methods, invoices, cancellation.
- Stripe is the source of truth for subscription state; Nexefiy mirrors it in `subscriptions` via webhooks.
- **Entitlements** are derived from `plan_entitlements[plan_key]` + overrides, and enforced server-side.

## 2. Plans (placeholders — owner decision required)

| Plan | Price | AI employees | Active workflows | Tasks / month | Integrations | Members | Notes |
|---|---|---|---|---|---|---|---|
| Trial (14 days) | free | 2 | 3 | 200 | 3 | 3 | no card required (decision open) |
| Starter | TBD | 3 | 10 | 1,000 | 5 | 5 | |
| Growth | TBD | 10 | 50 | 5,000 | unlimited | 20 | Slack approvals, longer retention |
| Enterprise | custom | custom | custom | custom | custom | custom | SSO, DPA, custom retention |

A "task" = one completed employee task or one workflow run, whichever applies (exact metering unit to confirm). Model cost is tracked internally for margin monitoring; usage-based overage billing via Stripe Billing Meters is a P1 option.

## 3. Entitlement keys

```
employees.max, workflows.active.max, tasks.monthly.max, integrations.max,
members.max, triggers.schedule.enabled, approvals.slack.enabled,
retention.task_events.days, employees.voice.enabled (later)
```

## 4. Enforcement points

| Action | Check |
|---|---|
| Create/activate employee | `employees.max` |
| Publish/activate workflow | `workflows.active.max`, trigger-type flags |
| Start task/run | `tasks.monthly.max` (atomic increment in `usage_counters`; reject when exceeded) |
| Connect integration | `integrations.max` |
| Invite member | `members.max` |

Enforced in module services and re-checked inside the worker before execution. UI shows remaining quota but never acts as the enforcement.

## 5. Webhooks

`/api/webhooks/stripe`: verify signature with `STRIPE_WEBHOOK_SECRET` → insert `stripe_events` (unique event id; skip duplicates) → handle: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`. Always re-fetch the subscription from Stripe rather than trusting event ordering.

## 6. Payment failure

`past_due` → banner + grace period (7 days, configurable) → `unpaid/canceled` → read-only mode: no new runs, employees paused, data retained and exportable.

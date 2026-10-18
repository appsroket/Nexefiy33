# MVP Scope

The MVP proves one complete loop: **an organization configures an AI employee with business context, connects real apps, gives it work (directly or via a workflow), approves its restricted actions, and sees the results.**

## In scope (P0)

**Platform**
- Supabase Auth (email/password, magic link), organizations, roles, invitations, org switching.
- Business profile and knowledge base (document upload, chunking, embeddings, retrieval with citations).

**Employees**
- Shared employee runtime with versioned configuration.
- Three templates: **Customer Support**, **Sales Development**, **Executive Assistant**. Custom (blank) employees.
- In-app chat to assign ad-hoc tasks.
- Text only — no voice.

**Tools and integrations** (each must pass a real sandbox/test-account check before being marked available)
- Gmail (read, draft, send), Google Calendar (read availability, create event), Slack (post message, read channel), HubSpot (contacts, deals, notes), outbound webhook.
- Internal tools: knowledge search, create task, notify user.

**Workflows**
- Natural-language → validated draft; visual editor; manual node configuration.
- Triggers: manual, schedule, integration event (Gmail new email, HubSpot new contact), webhook.
- Nodes: employee task, tool action, condition, approval, delay.
- Draft/publish versioning.

**Governance**
- Policy engine with risk levels; approval inbox; email notifications; kill switches; per-org spending limits; audit log.

**Observability and analytics**
- Task/run timelines with step detail; retry/cancel.
- Basic dashboard (tasks, success rate, approvals, cost per employee).

**Billing**
- Stripe subscriptions (one trial + two paid plans), entitlements enforcement, model-usage metering.

## Out of scope for MVP

- Voice employees and telephony.
- Marketing, analytics, operations, finance admin, HR admin, research templates (runtime supports them; templates come later).
- Parallel/loop/sub-workflow nodes; dry-run mode.
- Agency / multi-client management, SSO/SAML, custom roles.
- Marketplace of third-party skills.
- Mobile apps.
- On-premise or customer-hosted deployment.

## MVP acceptance criteria

1. Two users in two different organizations cannot read or modify each other's data via UI, API routes, or direct Supabase calls with their own JWT (pgTAP + e2e tests prove it).
2. A new user can sign up, create an org, fill the business profile, upload a document, create a Support employee, and get a cited answer from it.
3. With Gmail connected on a test account, a workflow "When an email arrives, draft a reply using the knowledge base and send after approval" runs end-to-end: trigger → draft → approval request → approve → email sent → task marked complete, all visible in the run timeline and audit log.
4. Rejecting the approval prevents the send; the run ends in `rejected` and no external call is made.
5. A natural-language workflow description produces a draft that passes validation, or a clear list of validation errors — never a silently broken workflow.
6. Pausing an employee stops its in-flight run before the next step.
7. A run survives a redeploy mid-wait (approval pending) and resumes correctly.
8. Exceeding the plan's task quota blocks new runs with a clear message; upgrading via Stripe restores access.
9. No privileged key appears in the client bundle (automated check in CI).

## Open product decisions (need owner input)

- Final MVP integration list (proposed above) — confirm or swap (e.g. Outlook instead of Gmail, Pipedrive instead of HubSpot).
- Pricing plans and quotas (placeholders in [billing-and-entitlements.md](billing-and-entitlements.md)).
- Whether the MVP needs Slack approvals or in-app + email is enough.

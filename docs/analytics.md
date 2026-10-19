# Analytics

How Nexefiy measures its AI workforce (Phase 15, ADR-030). The metric catalogue lives in code (`src/modules/analytics/domain/metrics.ts`, `outcomes.ts`) and is shown in the app at `/app/analytics/definitions`; this page explains the design.

## 1. Principles

- **Only persisted data.** Every number is an aggregate of rows the platform wrote when something happened: `tasks`, `task_attempts`, `approval_requests`, `audit_logs`, `tool_executions`, `workflow_runs`, `workflow_run_steps`, `usage_records`, `outcome_records`. Nothing is typed in by hand, sampled or invented.
- **Measured, calculated or estimate — always labelled.**
  - *Measured*: a count of records (tasks completed, actions failed, approvals decided, tokens the provider reported).
  - *Calculated*: a fixed formula over measured records (rates, medians, cost = tokens × list price).
  - *Estimate*: depends on an assumption about something not observed. There is one: projected month-end model spend (month-to-date ÷ days elapsed × days in month; not shown before day 3).
- **No unsupported claims.** Task completion is never presented as revenue, and no "hours saved" figure is shown: nothing records how long a person would have taken. Outcomes the connected apps can't report (appointments booked, tickets resolved, revenue) are listed as not measurable, with what they need, instead of being shown as zero.
- **Evidence for every number.** Each metric names the fact source and flag behind it; the evidence page lists exactly those rows, with links to the task, run or action.
- **Tenant isolation.** The metric functions are `SECURITY DEFINER`, check that the caller is a member of the organization (admin for model usage) and filter every query by `organization_id`. pgTAP 014 calls them as an outsider and as another workspace's owner.

## 2. Cohorts and time

| Data | Counted by | Note |
|---|---|---|
| Tasks (employee tasks only) | `created_at` in the period | Their outcome so far; open tasks are left out of every rate |
| Actions (AI employee tasks and workflow steps) | `created_at` | A person's own actions are excluded |
| Workflow runs | `queued_at` | |
| Outcomes | `occurred_at` | When the proving action finished |
| Model usage (admins) | `occurred_at` of usage records | Includes playground and test runs |

Periods are UTC: last 7/30/90 days, this month, last month. Evidence links carry the exact `from`/`to`. The database refuses windows over 366 days.

## 3. Scopes

Organization, department, employee and workflow, computed in one pass with `GROUP BY GROUPING SETS`. The **department** of a task is the one configured on the employee version that ran it (`profile.department`), so history doesn't move when an employee is reconfigured; versions without one show as "No department set". A workflow's task metrics are the employee tasks inside its runs; its run metrics come from `workflow_runs`.

## 4. Key definitions

- **Completed by AI employees**: status `succeeded` and no person took the task over. The runtime only marks a task succeeded when verification against the executor's records didn't fail.
- **Verified completion rate**: completed with verification status `verified` ÷ finished (succeeded, failed or cancelled, including tasks a person took over).
- **Recovery success**: tasks with a failed or timed-out attempt followed by another attempt that ended completed ÷ such tasks that finished. Waiting for an approval doesn't start a new attempt.
- **Human intervention**: a task needed a person if an approval on it was decided by a person, it was handed off (or the employee asked for a handoff), or a person used a task control (reply, pause, resume, retry, reassign, cancel, complete after takeover) — read from the audit log, which retention never purges. Priority changes don't count.
- **Integration errors**: tool executions with status `failed`, by provider and error code; rate = failed ÷ (succeeded + failed).
- **Execution time**: time to complete (created → completed, including waits) median and 90th percentile; processing time (attempts' active time) median.
- **Time to first message**: from task creation to the first succeeded `external_message` action. It is not customer response time — no inbound channel exists yet.
- **Model cost**: provider-reported tokens × list prices in the model catalog, so labelled *calculated*; invoices can differ.

## 5. Outcomes

`private.action_outcomes` (SQL) and `outcomesForAction` (TypeScript, kept in step by an integration test) map a succeeded action to the outcomes it proves. The trigger `record_action_outcomes` on `tool_executions` writes them to `outcome_records` with `tool_execution_id`, `task_id`, `employee_id`, `workflow_run_id` and a `subject` (the provider's record id, never an email). Only AI work records outcomes. Because they are captured at success, evidence retention (which clears action payloads) never changes them.

| Outcome | From | Counted as |
|---|---|---|
| Leads marked qualified | `hubspot.contacts.upsert` with lifecycle stage MQL/SQL | distinct contacts |
| Contacts created | `hubspot.contacts.upsert` with result `created` | distinct contacts |
| CRM notes logged | `hubspot.notes.create` | records |
| Messages sent | `slack.messages.post` | records |
| Appointments booked, tickets resolved | — | not measurable (no calendar or help desk integration) |

Adding an outcome: add the rule to a **new** migration (replace `private.action_outcomes`), to `outcomesForAction` and `OUTCOMES`, and a case to the parity test in `tests/integration/analytics.test.ts`.

## 6. Tests

- pgTAP `014_analytics.test.sql`: outcome capture (insert and update paths, once per action, not for failed or person actions, survives payload purge); every aggregate against a hand-counted data set; evidence rows; membership, admin and period checks; cross-organization isolation.
- `tests/integration/analytics.test.ts`: tasks run through the real runner and executor, then read through `server/queries` as a member — every count equals its evidence (sums equal the evidence rows' values), every rate's numerator and denominator equal theirs; SQL/TypeScript outcome parity; model usage admin-only; another workspace reads nothing.
- `tests/analytics/domain.test.ts`: catalogue integrity (evidence flags are real boolean/count columns of the facts functions, parsed from the migration), labels, formulas, projection, periods, evidence links, no hours-saved or revenue claims.

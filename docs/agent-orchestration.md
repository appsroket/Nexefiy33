# Agent Orchestration

How multiple AI employees, tools, humans, and time are coordinated.

## 1. Orchestration model

Nexefiy uses **explicit, workflow-driven orchestration** rather than free-form agent-to-agent conversation:

- A **workflow** (versioned graph) defines who does what, in what order, under which conditions.
- Each **employee task node** runs one employee on one bounded assignment and produces a typed output.
- Data passes between nodes through **declared outputs** referenced by later nodes (`{{nodes.classify.output.category}}`), validated against schemas.
- Employees may **hand off** work by calling the `task.delegate` tool, which creates a new task for another employee *only* if the workflow or org policy allows that delegation pair. Delegation depth is capped (default 2).

Rationale (ADR-006): explicit graphs are auditable, testable, and predictable; unconstrained multi-agent chatter is expensive and hard to supervise.

## 2. Execution engine

Trigger.dev (ADR-004) runs:

| Task | Purpose |
|---|---|
| `workflow.run` | Orchestrates a run: walks the graph, schedules node executions, persists state. |
| `workflow.node.employee` | Runs the employee runtime for one node. |
| `workflow.node.tool` | Executes a single deterministic tool action. |
| `employee.task` | Ad-hoc task assigned from chat or API. |
| `trigger.schedule.*` | Cron-triggered workflow starts. |
| `integration.webhook.process` | Converts a stored webhook event into workflow starts. |

### State and durability

- Source of truth for run/task status is **Postgres** (`workflow_runs`, `tasks`, `task_attempts`). Trigger.dev executes jobs (ADR-026): `employee-tasks.sweep` every minute, `employee-tasks.dispatch` on demand, and `employee-tasks.run` per task. A job carries only the task id and claims the task itself under a lease; every write is conditional on still holding the attempt.
- After every step the runtime saves a checkpoint; a step re-executed after a crash continues from it, and tool calls use stable idempotency keys (`task:<task>:<model call id>`), so they are never repeated.
- **Waits** (approval, a requester's reply, dependencies, a pause) are task states in Postgres, not engine waitpoints: nothing runs while a task waits. Approval decisions, replies, resumes, retries and finished dependencies re-queue the task (SQL triggers/functions), and the next dispatch starts a job. *(Earlier drafts of this document described waitpoint tokens; replaced so the engine stays replaceable and no decision depends on an engine token.)*
- **Cancellation / pause:** the runner checks task and employee status and the deadline before each step; cancelling also withdraws pending approvals immediately. Workflow runs (not built) will reuse the same task life cycle.

### Delivery semantics

- Steps are **at-least-once**. All external-write tools require an idempotency key = hash(run_id, node_id, attempt-independent call index). Adapters use provider idempotency features where available, or a `tool_invocations.idempotency_key` uniqueness check before calling.
- Retries: exponential backoff for retryable errors (network, 429, 5xx); no retry for validation/authorization/policy errors.

## 3. Concurrency and limits

- Per-org concurrency limit on active runs (entitlement-driven) using Trigger.dev concurrency keys = `organization_id`.
- Per-employee max concurrent tasks.
- Per-run limits: max nodes executed, max wall time, max cost.
- Global kill switch per org checked at each step boundary.

## 4. Human-in-the-loop

```
tool call → policy = require_approval
   → create approval_request (pending) + notify approvers
   → step status = waiting, waitpoint token stored
   → human decides in UI (approve / edit & approve / reject)
   → decide_approval RPC (atomic) → server completes token with decision
   → step resumes: execute (with edited input if allowed) or record rejection
   → expiry: scheduled check marks expired → step resumes with 'expired' → workflow follows its on_reject/on_expire branch (default: fail run)
```

## 5. Triggers

| Type | Mechanism |
|---|---|
| Manual | UI/API → enqueue `workflow.run`. |
| Schedule | Trigger.dev declarative/imperative schedules keyed by `workflow_trigger.id`. |
| Integration event | Provider webhook → `integration_webhook_events` → match triggers by connection + event type → enqueue. Polling adapter where no webhook exists. |
| Webhook | Per-trigger secret URL with HMAC verification. |

Trigger payloads are stored by reference (row id), and only summarized/sanitized fields enter model context.

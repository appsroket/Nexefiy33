# Agent Orchestration

How multiple AI employees, tools, humans, and time are coordinated.

## 1. Orchestration model

Nexefiy uses **explicit, workflow-driven orchestration** rather than free-form agent-to-agent conversation:

- A **workflow** (versioned graph) defines who does what, in what order, under which conditions.
- Each **employee task node** runs one employee on one bounded assignment and produces a typed output.
- Data passes between nodes through **declared outputs** referenced by later nodes (`{{nodes.classify.output.category}}`), validated against schemas.
- Employees **hand off** work only through explicit workflow definitions: a connection from one employee's step to another employee's step in an *activated* version. Employees have no tool that creates tasks or hands work to someone else (a test checks the tool catalog). At activation, workspace policy is asked about each hand-off (pseudo-action `workflow.handoff` for the receiving employee): `deny` blocks activation, `require_approval` requires an approval step on every path between the two. *(Earlier drafts described a `task.delegate` tool; not built — hand-offs are workflow edges, ADR-027.)*

Rationale (ADR-006): explicit graphs are auditable, testable, and predictable; unconstrained multi-agent chatter is expensive and hard to supervise.

## 2. Execution engine

Trigger.dev (ADR-004) runs:

| Job | Purpose |
|---|---|
| `employee-tasks.sweep` | Every minute: the dispatcher (approval expiry, deadline timeouts, approved actions, due schedules, runs to advance, due tasks). |
| `employee-tasks.dispatch` | The same, on demand (an assignment, a decision, a run started, a task finished). |
| `employee-tasks.run` | Claims and runs one employee task (including a workflow's employee step). |
| `workflow-runs.advance` | Claims one workflow run under a lease and advances it as far as it can go now (built in Phase 12). |
| `integration.webhook.process` | *Not built:* converting stored webhook events into workflow starts. |

### State and durability

- Source of truth for run/task status is **Postgres** (`workflow_runs`, `tasks`, `task_attempts`). Trigger.dev executes jobs (ADR-026): `employee-tasks.sweep` every minute, `employee-tasks.dispatch` on demand, and `employee-tasks.run` per task. A job carries only the task id and claims the task itself under a lease; every write is conditional on still holding the attempt.
- After every step the runtime saves a checkpoint; a step re-executed after a crash continues from it, and tool calls use stable idempotency keys (`task:<task>:<model call id>`), so they are never repeated.
- **Waits** (approval, a requester's reply, dependencies, a pause) are task states in Postgres, not engine waitpoints: nothing runs while a task waits. Approval decisions, replies, resumes, retries and finished dependencies re-queue the task (SQL triggers/functions), and the next dispatch starts a job. *(Earlier drafts of this document described waitpoint tokens; replaced so the engine stays replaceable and no decision depends on an engine token.)*
- **Cancellation / pause:** the runner checks task and employee status and the deadline before each step; cancelling also withdraws pending approvals immediately.
- **Workflow runs** (Phase 12, ADR-027): a run pins its version and is authorized by the admin who activated it. The orchestrator claims the run (`claim_workflow_runs`, lease token), brings steps up to date from their tasks, plans with one rule — a step runs when all its incoming connections are decided and at least one was taken, and is skipped when none was — which gives sequential, conditional and parallel (fan-out/join) execution, acts, and records (`record_workflow_progress`, only while holding the lease; finished steps never change). Trigger, condition, transformation and end steps are decided at once; delays are a due time; every step that does work is a task (employee steps are employee tasks; tool actions are tasks the executor finishes, as a `WorkflowActor` limited to the version's exact action and connection; approval steps are tasks with a `workflow_gate` approval request). A task changing state wakes its run (`wake_workflow_run`). Deadlines (`deadline_at` from the version's time limit), spend limits, failure and rejected paths, and cancellation (`cancel_workflow_run`: the run ends, pending work is withdrawn, a running employee step stops after its current step) are enforced in the same loop.

### Delivery semantics

- Steps are **at-least-once**. All external-write tools require an idempotency key = hash(run_id, node_id, attempt-independent call index). Adapters use provider idempotency features where available, or a `tool_invocations.idempotency_key` uniqueness check before calling.
- Retries: exponential backoff for retryable errors (network, 429, 5xx); no retry for validation/authorization/policy errors.

## 3. Concurrency and limits

- Per-org concurrency limit on active runs (entitlement-driven) using Trigger.dev concurrency keys = `organization_id`.
- Per-employee max concurrent tasks.
- Per-run limits: max nodes executed, max wall time, max cost.
- Global kill switch per org checked at each step boundary.

## 4. Human-in-the-loop

Built (Phases 8–12): tool actions that need approval create a payload-bound `approval_requests` row (the tool execution waits, the employee task or workflow step waits as a state); workflow **approval steps** create a `workflow_gate` request whose fingerprint the database computes from exactly what the approver sees; `decide_approval` settles either kind (an approved gate completes its step; rejected or expired follows the step's rejected path, or ends the run as rejected). Expiry is swept by `expire_overdue_approvals`. No engine waitpoints are used (ADR-026). The sketch below is the original design; "waitpoint token" steps were replaced by task states.

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
| Manual | **Built:** the Run form → `start_workflow_run` (inputs checked against the version) → the next dispatch advances it. |
| Schedule | **Built:** activation registers a `workflow_triggers` row for the version (cron + IANA zone, next run computed on the server); the dispatcher starts due runs with `start_scheduled_workflow_run` (one run per slot) and moves the schedule on. |
| Integration event | *Not built.* Provider webhook → `integration_webhook_events` → match triggers by connection + event type → enqueue. Polling adapter where no webhook exists. |
| Webhook | *Not built.* Per-trigger secret URL with HMAC verification. |

Trigger payloads are stored by reference (row id), and only summarized/sanitized fields enter model context.

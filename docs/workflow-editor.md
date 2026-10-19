# Workflow Builder

Built in Phase 12 (ADR-027). Three ways to build the same artifact — one **workflow definition** (graph schema version 2):

1. **Natural language** → a draft generated from what the workspace has (`server/generation.ts`).
2. **Visual editing** on a React Flow canvas (`@xyflow/react`, `ui/workflow-canvas.tsx`).
3. **Manual configuration** of every step in forms, or the JSON view (`ui/step-form.tsx`, `ui/workflow-editor.tsx`) — no AI required.

All three read and write the same definition; the canvas is a view, not a separate format. Node positions are stored separately (`draft_layout`, `workflow_versions.layout`) so moving a step never changes what the workflow does.

## 1. Definition (graph schema v2)

`src/modules/workflows/domain/types.ts` (Zod-free; Zod schema in `domain/schemas.ts`; the database checks the outline with `private.workflow_graph_v2_is_valid`).

```ts
WorkflowDefinition = {
  inputs: { key, label, type: 'text'|'long_text'|'number'|'boolean'|'email', required, description }[],
  nodes: Node[],
  edges: { id, source, target, branch?: 'true'|'false'|'approved'|'rejected'|'failure' }[],
  settings: { maxRunMinutes, maxCostUsd | null },
}

Node = { id, label, type, config } where type/config is one of:
  trigger        { kind: 'manual' | 'schedule', cron, timezone }          // exactly one; schedule = 5-field cron, IANA zone, ≥ 5 min apart
  employee_task  { employeeId, employeeVersionId?, instructions, outputs: {key, description}[],
                   timeoutMinutes, requireVerified, retry: {maxAttempts, backoffSeconds} }
  tool_action    { toolKey, integrationId, input: {field, value}[], requireApproval, retry }
  condition      { match: 'all'|'any', rules: {left, operator, right}[] } // fixed operators, no code
  approval       { message, approverRole: 'operator'|'admin'|'owner', expiresInHours }
  transform      { fields: {key, value, format: 'text'|'number'|'boolean'|'lowercase'|'uppercase'|'trim'}[] }
  delay          { minutes }
  end            { status: 'succeeded'|'failed', summary }
```

Paths: no branch is the normal ("then") path. Conditions need `true` and `false`; approvals need `approved` (`rejected` covers rejection and expiry — without it the run ends as *rejected*); employee tasks and tool actions may have a `failure` path (without it a failure fails the run). Several connections out of a step run in parallel; a step with several incoming connections waits for all of them. End steps have no outgoing connections. No cycles.

**Data mappings** use references, parsed by a restricted grammar and resolved by walking plain data — never evaluated:
`{{inputs.<key>}}`, `{{steps.<id>.output.<path>}}`, `{{run.id}}`, `{{run.startedAt}}`. A value that is exactly one reference keeps its type; otherwise it is text. Outputs: employee task → `summary`, `status` and its declared `outputs`; tool action → the action's output fields; condition → `result`; approval → `decision`, `note`; transformation → its fields.

**Retry behavior:** employee tasks use the task runtime's attempts (temporary failures retried from the checkpoint); tool actions retry only temporary failures (rate limits, timeouts, outages) with doubling backoff, and only when the executor deems a repeat safe. **Completion criteria:** `requireVerified` (an employee result must pass verification and be fully completed), required outputs, and the end step reached (its status and summary are the run's result).

## 2. Validation

`domain/validation.ts` runs in the editor, on every save (stored as `draft_validation`) and again on the server before activation (`server/validation.ts`), where the context is read from the database:

| Stage | Checks |
|---|---|
| Shape | Zod parse (types, bounds); unknown step types rejected. JSON from the editor or a model is normalized first (`normalizeDefinition`). |
| Structure | One trigger, at least one end, connections between existing steps, branches the source allows, required paths present, no self-connections or edges into the trigger, no cycles, nothing unreachable, limits (50 steps, 100 connections, 20 inputs). |
| Steps | Every step's settings complete and in range (schedule valid and no required inputs on scheduled workflows). |
| References | Valid grammar, no stray braces; inputs exist; the referenced step **always runs before** this one (dominator check) and not only on its failure path; the output exists. |
| Resources | Employees in the workspace and active; actions exist; mapped fields exist and required ones are mapped; connections in the workspace, of the action's provider, connected. Warnings while drafting, errors at activation. |
| Permissions (server) | Each tool action's decision now from the integration executor (connection, scopes, setting, workspace policies): a denied action blocks activation. Hand-offs between employees: workspace policy on `workflow.handoff` for the receiving employee — `deny` blocks, `require_approval` requires an approval step on every path between them. |

A warning flags writes nobody reviews (no approval step before them, the step doesn't force approval, and the action doesn't require it): the connection's setting or a policy decides, and admins see it.

## 3. Natural-language generation

```
description → prompt with the workspace's active employees (ids, names, tools), actions (fields, outputs)
  and connected connection ids — nothing else
  → structured output (flat proposal schema) → normalize → validate
  → if invalid: one repair attempt with the problems listed
  → saved as a draft (draft_source 'ai_generated', draft_generation: model, repaired, counts, notes, unsupported)
```

Without a model (or if the model fails), keyword rules draft it (`domain/rule-drafter.ts`), labelled as such. Either way: the result is **always a draft**; requests the workspace can't serve (email, calendars, event triggers…) are listed as not included instead of invented; approval steps are placed before changes; the description is treated as data.

## 4. Editing

Canvas (add steps from the palette, connect handles per path, move, delete, select to edit in the side panel), Steps (every step's form and connections), Inputs & limits, JSON. Live validation with problems shown on steps; undo/redo; unsaved-changes guard; **optimistic locking** (`lock_version`): a save over a teammate's newer save is refused.

## 5. Activation and versions

Admins activate (typed name). The server validates the **stored** draft, pins each employee step to the employee's active version, and `publish_workflow_version` (service role) re-checks the role, the lock and the name and inserts an immutable `workflow_versions` row (`graph_sha256`, layout, validation report with permissions and hand-offs). The workflow becomes active; a schedule is registered for the version. Versions can be viewed and restored into the draft (rollback = activate it again as a new version). Pause (operators) stops new runs; resume, archive and restore are for admins; only never-activated drafts can be deleted.

## 6. Runs

Started by operators (`start_workflow_run`: inputs checked against the version in SQL) or by a due schedule. Each run pins its version and is authorized by the version's activator. The orchestrator (`server/orchestrator.ts`, see docs/agent-orchestration.md) advances it; run pages show the graph with step statuses, inputs and outputs, approvals, actions (completed changes marked as not undone), cost, duration and history, and let operators cancel.

Not built: integration-event and webhook triggers, natural-language edits as reviewable diffs, version diffs, loops, sub-workflows, dry runs.

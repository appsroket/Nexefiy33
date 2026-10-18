# Workflow Editor

Three ways to build the same artifact — a validated **WorkflowDefinition**:

1. **Natural language** → AI generates a draft.
2. **Visual editing** in a React Flow canvas.
3. **Manual configuration** of every node via forms (no AI required).

All three read and write the same definition; the canvas is a view, not a separate format.

## 1. WorkflowDefinition (schema v1)

```ts
WorkflowDefinition = {
  schemaVersion: 1,
  trigger: { type: 'manual' | 'schedule' | 'integration_event' | 'webhook', config: {...} },
  inputs?: JSONSchema,                       // shape of trigger payload exposed to nodes
  nodes: Node[],
  edges: { id, source, target, condition?: 'true' | 'false' | 'approved' | 'rejected' | 'expired' }[],
  settings: { maxRunMinutes, maxCostUsd, onFailure: 'stop' | 'notify' },
}

Node =
  | { id, type: 'employee_task', employeeId, instructions, outputSchema?: JSONSchema }
  | { id, type: 'tool_action', toolKey, connectionId?, input: TemplatedInput }
  | { id, type: 'condition', expression: ConditionExpr }      // safe expression AST, no eval
  | { id, type: 'approval', approverRole: 'owner'|'admin'|'operator', message, expiresInHours }
  | { id, type: 'delay', duration: ISO8601Duration }
  // P1: parallel, join, loop; P2: sub_workflow
```

`TemplatedInput` values may reference `{{trigger.*}}` and `{{nodes.<id>.output.*}}`. References are parsed and resolved by a restricted resolver (no code execution).

Node positions for the canvas are stored separately in `ui_layout` so layout changes don't create semantic diffs.

## 2. Validation pipeline

Run on every save of a draft and again on publish:

| Stage | Checks |
|---|---|
| 1. Schema | Zod parse of the full definition; unknown node types rejected. |
| 2. Structure | Exactly one entry; all edges reference existing nodes; no unreachable nodes; cycles rejected (until loop node exists); condition nodes have both branches or a default. |
| 3. References | All `{{...}}` references resolve to upstream nodes/trigger fields with compatible types. |
| 4. Resources | Employees exist in this org and are active; tools exist in the registry; connections exist, are connected, and belong to this org; employees are granted the tools used in their nodes. |
| 5. Entitlements | Node count, trigger type, and integrations allowed by the plan. |
| 6. Policy | Any `tool_action` node with external-write risk is preceded by an approval node **or** covered by an explicit autonomy rule; otherwise warning (draft) / error (publish), per org setting. |

Output: `{ valid, errors: [{ path, code, message }], warnings }` — shown inline on the canvas.

## 3. Natural-language generation

```
user description
  → server: build prompt with (org's employees, granted tools, connections, schema docs, examples)
  → model returns WorkflowDefinition JSON via structured output / tool call
  → validation pipeline
  → if invalid: one automatic repair attempt with the error list
  → save as draft with generation metadata (prompt, model, validation result)
  → user reviews in canvas
```

Rules:
- Generated workflows are **always drafts**. Publishing requires an explicit human action.
- The model only sees ids/names of resources in the current org; it cannot reference others, and validation re-checks anyway.
- If the request needs an unavailable integration, the result explains what to connect rather than inventing a node.
- NL edits on an existing draft ("add an approval before sending") produce a diff the user accepts or rejects.

## 4. Visual editor

- `@xyflow/react` canvas; custom node components per node type; side panel with the node's form (shared with manual mode).
- Validation errors shown on nodes and edges.
- Undo/redo, autosave draft (debounced), optimistic locking on `updated_at` to avoid overwriting a teammate's edits.
- Read-only view of published versions; diff between versions (P1).

## 5. Publishing and versioning

`publish` → full validation → insert immutable `workflow_versions` row → set `current_version_id` → (re)register triggers. Running runs keep their pinned version. Rollback = publish a previous version as new.

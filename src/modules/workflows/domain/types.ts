// The shape of a workflow (graph schema version 2) and the vocabulary the
// builder uses. One definition serves all three ways of building a workflow:
// the generator writes it, the canvas draws it, and the step forms and the
// JSON view edit it directly. Node positions live separately (WorkflowLayout)
// so moving a node never changes what the workflow does.
//
// Zod-free because client components import it. The matching Zod schema is
// in ./schemas.ts; the database checks the outline of the same shape
// (private.workflow_graph_is_valid, version 2) and the server checks every
// resource and permission before a version is activated.

export const GRAPH_SCHEMA_VERSION = 2

export const NODE_TYPES = ['trigger', 'employee_task', 'tool_action', 'condition', 'approval', 'transform', 'delay', 'end'] as const
export type NodeType = (typeof NODE_TYPES)[number]

/** Edge branches. No branch is the normal ("then") path. */
export const BRANCHES = ['true', 'false', 'approved', 'rejected', 'failure'] as const
export type Branch = (typeof BRANCHES)[number]

export const INPUT_TYPES = ['text', 'long_text', 'number', 'boolean', 'email'] as const
export type InputType = (typeof INPUT_TYPES)[number]

export const CONDITION_OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'] as const
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]

export const TRANSFORM_FORMATS = ['text', 'number', 'boolean', 'lowercase', 'uppercase', 'trim'] as const
export type TransformFormat = (typeof TRANSFORM_FORMATS)[number]

export const APPROVER_ROLES = ['operator', 'admin', 'owner'] as const
export type ApproverRole = (typeof APPROVER_ROLES)[number]

export const TRIGGER_KINDS = ['manual', 'schedule'] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]

export const WORKFLOW_BOUNDS = {
  nodes: 50,
  edges: 100,
  inputs: 20,
  label: 80,
  name: 200,
  description: 2000,
  instructions: 6000,
  template: 4000,
  outputs: 10,
  mappings: 30,
  rules: 10,
  fields: 20,
  maxRunMinutes: 10_080,
  maxCostUsd: 1000,
  maxAttempts: 5,
  backoffSeconds: 3600,
  timeoutMinutes: 10_080,
  expiresInHours: 168,
  delayMinutes: 10_080,
} as const

export const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,39}$/

export interface WorkflowInput {
  key: string
  label: string
  type: InputType
  required: boolean
  description: string
}

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number
  /** Wait before the next attempt (tool actions; employee tasks use the task runtime's backoff). */
  backoffSeconds: number
}

export interface TriggerConfig {
  kind: TriggerKind
  /** Five-field cron expression, only for kind "schedule". */
  cron: string
  /** IANA time zone, only for kind "schedule". */
  timezone: string
}

export interface OutputField {
  key: string
  description: string
}

export interface EmployeeTaskConfig {
  employeeId: string
  /** Stamped by the server when a version is activated: the employee version this workflow version runs. */
  employeeVersionId?: string
  /** Templated: may reference inputs and earlier steps' outputs. */
  instructions: string
  /** Values the employee must report when it finishes; later steps can use them. */
  outputs: OutputField[]
  timeoutMinutes: number
  /** Completion criterion: the result must pass verification without anything needing review. */
  requireVerified: boolean
  retry: RetryPolicy
}

export interface FieldMapping {
  /** The action's input field. */
  field: string
  /** Templated value. A value that is exactly one reference keeps its type. */
  value: string
}

export interface ToolActionConfig {
  toolKey: string
  integrationId: string
  input: FieldMapping[]
  /** Always ask for approval of the exact payload, even where the connection would allow it. */
  requireApproval: boolean
  retry: RetryPolicy
}

export interface ConditionRule {
  /** Templated value to test, usually one reference. */
  left: string
  operator: ConditionOperator
  /** Templated value to compare with (unused by is_empty / is_not_empty). */
  right: string
}

export interface ConditionConfig {
  match: 'all' | 'any'
  rules: ConditionRule[]
}

export interface ApprovalConfig {
  /** Templated: what the approver is asked, with the data they need. */
  message: string
  approverRole: ApproverRole
  expiresInHours: number
}

export interface TransformField {
  key: string
  value: string
  format: TransformFormat
}

export interface TransformConfig {
  fields: TransformField[]
}

export interface DelayConfig {
  minutes: number
}

export interface EndConfig {
  /** How a run that reaches this step ends. */
  status: 'succeeded' | 'failed'
  /** Templated summary recorded as the run's result. */
  summary: string
}

interface NodeBase<T extends NodeType, C> {
  id: string
  type: T
  label: string
  config: C
}

export type TriggerNode = NodeBase<'trigger', TriggerConfig>
export type EmployeeTaskNode = NodeBase<'employee_task', EmployeeTaskConfig>
export type ToolActionNode = NodeBase<'tool_action', ToolActionConfig>
export type ConditionNode = NodeBase<'condition', ConditionConfig>
export type ApprovalNode = NodeBase<'approval', ApprovalConfig>
export type TransformNode = NodeBase<'transform', TransformConfig>
export type DelayNode = NodeBase<'delay', DelayConfig>
export type EndNode = NodeBase<'end', EndConfig>

export type WorkflowNode = TriggerNode | EmployeeTaskNode | ToolActionNode | ConditionNode | ApprovalNode | TransformNode | DelayNode | EndNode

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  branch?: Branch
}

export interface WorkflowSettings {
  /** The run fails as timed out if it hasn't finished by then (waiting included). */
  maxRunMinutes: number
  /** Total model spend of the run's employee tasks; no new step starts once it is reached. */
  maxCostUsd: number | null
}

export interface WorkflowDefinition {
  inputs: WorkflowInput[]
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  settings: WorkflowSettings
}

export type WorkflowLayout = Record<string, { x: number; y: number }>

export const WORKFLOW_STATUSES = ['draft', 'active', 'paused', 'archived'] as const
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number]

export const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'rejected', 'timed_out'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const FINISHED_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'rejected', 'timed_out']

export const STEP_STATUSES = ['running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled'] as const
export type StepStatus = (typeof STEP_STATUSES)[number]
export const FINISHED_STEP_STATUSES: readonly StepStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled']

export type DraftSource = 'manual' | 'ai_generated' | 'rules' | 'template' | 'imported'

// --- Display vocabulary --------------------------------------------------------

export interface NodeTypeInfo {
  label: string
  description: string
  /** Branches its outgoing edges may carry ("" = the normal path). */
  branches: readonly ('' | Branch)[]
  /** Branches it must have at least one edge for. */
  requiredBranches: readonly ('' | Branch)[]
}

export const NODE_TYPE_INFO: Record<NodeType, NodeTypeInfo> = {
  trigger: { label: 'Trigger', description: 'How a run starts: by hand or on a schedule.', branches: [''], requiredBranches: [''] },
  employee_task: {
    label: 'Employee task',
    description: 'An active AI employee works on a bounded task with its own granted tools.',
    branches: ['', 'failure'],
    requiredBranches: [''],
  },
  tool_action: {
    label: 'Tool action',
    description: 'One integration action, checked by the executor and its approval rules.',
    branches: ['', 'failure'],
    requiredBranches: [''],
  },
  condition: { label: 'Condition', description: 'Follows the “true” or “false” path depending on data.', branches: ['true', 'false'], requiredBranches: ['true', 'false'] },
  approval: {
    label: 'Approval',
    description: 'Waits for a person to approve before continuing.',
    branches: ['approved', 'rejected'],
    requiredBranches: ['approved'],
  },
  transform: { label: 'Data transformation', description: 'Builds new values from earlier data (no code).', branches: [''], requiredBranches: [''] },
  delay: { label: 'Delay', description: 'Waits a fixed time before continuing.', branches: [''], requiredBranches: [''] },
  end: { label: 'End / result', description: 'Finishes this path with a result.', branches: [], requiredBranches: [] },
}

export const BRANCH_LABELS: Record<Branch, string> = {
  true: 'True',
  false: 'False',
  approved: 'Approved',
  rejected: 'Rejected or expired',
  failure: 'On failure',
}

export const INPUT_TYPE_LABELS: Record<InputType, string> = {
  text: 'Text',
  long_text: 'Long text',
  number: 'Number',
  boolean: 'Yes / no',
  email: 'Email address',
}

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  contains: 'contains',
  not_contains: 'does not contain',
  greater_than: 'is greater than',
  less_than: 'is less than',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
}

export const UNARY_OPERATORS: readonly ConditionOperator[] = ['is_empty', 'is_not_empty']

export const FORMAT_LABELS: Record<TransformFormat, string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Yes / no',
  lowercase: 'Lowercase text',
  uppercase: 'Uppercase text',
  trim: 'Trimmed text',
}

export const WORKFLOW_STATUS_DISPLAY: Record<WorkflowStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  archived: { label: 'Archived', tone: 'neutral' },
}

export const RUN_STATUS_DISPLAY: Record<RunStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  waiting: { label: 'Waiting', tone: 'warning' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'danger' },
  timed_out: { label: 'Timed out', tone: 'danger' },
}

export const STEP_STATUS_DISPLAY: Record<StepStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  running: { label: 'Running', tone: 'info' },
  waiting: { label: 'Waiting', tone: 'warning' },
  succeeded: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

/** What the builder knows about the workspace, for forms and validation. */
export interface EmployeeOption {
  id: string
  name: string
  status: string
  activeVersionId: string | null
  activeVersion: number | null
  /** Tools the active version grants (keys). */
  toolKeys: string[]
}

export interface ToolOption {
  key: string
  title: string
  provider: string
  providerName: string
  risk: 'read' | 'write_internal' | 'write_external' | 'sensitive'
  approval: 'none' | 'default_required' | 'always'
  /** Top-level input fields: name, whether required, a short description. */
  fields: { name: string; required: boolean; description: string; type: string }[]
  /** Top-level output fields (for references to this step's output). */
  outputFields: string[]
}

export interface ConnectionOption {
  id: string
  provider: string
  label: string
  status: string
}

export interface BuilderContext {
  employees: EmployeeOption[]
  tools: ToolOption[]
  connections: ConnectionOption[]
}

// The shape of an AI employee and the vocabulary the pages use. Every
// category runs on the same runtime; an employee is this configuration plus
// its instructions, never separate code.
//
// Zod-free because client components import it. The matching Zod schema
// (with limits) is in ./schemas.ts and the database validates the same shape
// (private.employee_config_is_valid, schema version 2).

export const DEPARTMENTS = [
  'sales',
  'support',
  'marketing',
  'operations',
  'research',
  'analytics',
  'executive_assistant',
  'finance_admin',
  'hr_admin',
  'voice',
  'custom',
] as const
export type Department = (typeof DEPARTMENTS)[number]

export const DEPARTMENT_LABELS: Record<Department, string> = {
  sales: 'Sales',
  support: 'Customer support',
  marketing: 'Marketing',
  operations: 'Operations',
  research: 'Research',
  analytics: 'Analytics',
  executive_assistant: 'Executive assistance',
  finance_admin: 'Finance administration',
  hr_admin: 'HR administration',
  voice: 'Voice',
  custom: 'Other',
}

export const LIFECYCLE_STATES = ['draft', 'testing', 'active', 'paused', 'archived'] as const
export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

export const MODEL_TIERS = ['fast', 'balanced', 'deep'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export const MODEL_EFFORTS = ['low', 'medium', 'high'] as const
export type ModelEffort = (typeof MODEL_EFFORTS)[number]

export const KNOWLEDGE_ACCESS = ['none', 'all', 'selected'] as const
export type KnowledgeAccess = (typeof KNOWLEDGE_ACCESS)[number]

export const ESCALATION_BEHAVIORS = ['stop_and_report', 'ask_requester'] as const
export type EscalationBehavior = (typeof ESCALATION_BEHAVIORS)[number]

export const ESCALATION_BEHAVIOR_LABELS: Record<EscalationBehavior, string> = {
  stop_and_report: 'Stop and report why to the requester',
  ask_requester: 'Ask the requester a clarifying question',
}

export const TOOL_APPROVALS = ['allow', 'require_approval'] as const
export type ToolApproval = (typeof TOOL_APPROVALS)[number]

export interface EmployeeToolGrant {
  toolKey: string
  /** The connection the tool acts through; null for built-in tools. */
  integrationId: string | null
  /** The employee's own rule. It can only add approval, never remove one the connection or a policy requires. */
  approval: ToolApproval
}

export interface EmployeeConfig {
  profile: { name: string; department: Department; description: string; templateKey?: string }
  responsibilities: string[]
  skills: string[]
  tools: EmployeeToolGrant[]
  knowledge: { access: KnowledgeAccess; sourceIds: string[]; maxPassages: number }
  model: { provider: 'anthropic'; tier: ModelTier; effort: ModelEffort; maxOutputTokens: number }
  successCriteria: string[]
  allowedActions: string[]
  prohibitedActions: string[]
  escalation: { when: string[]; behavior: EscalationBehavior; notes: string }
  limits: { maxTurnsPerTask: number; maxToolCallsPerTask: number; maxCostUsdPerTask: number; maxRuntimeSeconds: number }
  budget: { monthlyUsd: number }
}

/** What the builder edits and saves: the configuration and the instructions. */
export interface EmployeeDraft {
  instructions: string
  config: EmployeeConfig
}

/** Bounds shared by the schema, the form and the database (keep in sync with the migration). */
export const CONFIG_BOUNDS = {
  name: 120,
  description: 2000,
  instructions: 20_000,
  listItem: 300,
  responsibilities: 20,
  successCriteria: 10,
  actions: 20,
  escalationWhen: 10,
  escalationNotes: 1000,
  tools: 30,
  skills: 20,
  sources: 50,
  maxPassages: { min: 1, max: 20 },
  maxOutputTokens: { min: 1024, max: 32_000 },
  maxTurnsPerTask: { min: 1, max: 50 },
  maxToolCallsPerTask: { min: 0, max: 100 },
  maxCostUsdPerTask: { min: 0.01, max: 50 },
  maxRuntimeSeconds: { min: 10, max: 900 },
  monthlyUsd: { min: 1, max: 10_000 },
} as const

export const TEST_STATUSES = ['untested', 'incomplete', 'failed', 'needs_review', 'passed'] as const
export type TestStatus = (typeof TEST_STATUSES)[number]

export const TEST_STATUS_DISPLAY: Record<TestStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  untested: { label: 'Not tested', tone: 'neutral' },
  incomplete: { label: 'Some tests not run', tone: 'warning' },
  failed: { label: 'Tests failing', tone: 'danger' },
  needs_review: { label: 'Waiting for review', tone: 'info' },
  passed: { label: 'Tests passed', tone: 'success' },
}

export const TEST_RUN_RESULTS = ['running', 'passed', 'failed', 'needs_review', 'error'] as const
export type TestRunResult = (typeof TEST_RUN_RESULTS)[number]

export const RUN_OUTCOMES = ['completed', 'limit_reached', 'escalated', 'refused', 'error'] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

export interface TestExpectations {
  mustUseTools?: string[]
  mustNotUseTools?: string[]
  mustRequestApproval?: string[]
  replyMustMention?: string[]
  mustEscalate?: boolean
}

/** A tool an employee can be given, as shown in the builder. */
export interface EmployeeToolInfo {
  key: string
  title: string
  description: string
  /** "knowledge" for built-in tools, otherwise the integration provider. */
  provider: 'knowledge' | 'hubspot' | 'slack'
  providerName: string
  risk: 'read' | 'write_internal' | 'write_external' | 'sensitive'
  /** The tool's own approval requirement (declared by its connector). */
  approvalRequirement: 'none' | 'default_required' | 'always'
  needsConnection: boolean
}

export interface ConnectionOption {
  id: string
  provider: string
  label: string
  status: string
}

export interface KnowledgeSourceOption {
  id: string
  name: string
  status: string
}

export interface SkillOption {
  key: string
  name: string
  description: string | null
  toolKeys: string[]
}

export function isWriteTool(tool: Pick<EmployeeToolInfo, 'risk'>): boolean {
  return tool.risk !== 'read'
}

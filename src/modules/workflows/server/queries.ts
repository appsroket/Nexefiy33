// Read models for the workflow pages, loaded with the user's session so RLS
// limits them to workspaces the user belongs to (and every query also filters
// by the active organization).

import 'server-only'

import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'
import type { Json } from '@/lib/supabase/types'

import { blankWorkflow, normalizeDefinition, reconcileLayout } from '../domain/factory'
import { workflowLayoutSchema } from '../domain/schemas'
import {
  RUN_STATUSES,
  STEP_STATUSES,
  WORKFLOW_STATUSES,
  type DraftSource,
  type RunStatus,
  type StepStatus,
  type WorkflowDefinition,
  type WorkflowLayout,
  type WorkflowStatus,
} from '../domain/types'
import type { ValidationReport } from '../domain/validation'
import { loadBuilderContext, WorkflowDataError } from './context'

function fail(what: string, error: { code?: string }): never {
  console.error(`[workflows] loading ${what} failed`, redact({ code: error.code }))
  throw new WorkflowDataError(`We couldn’t load ${what}. Please try again.`)
}

const asStatus = (value: string): WorkflowStatus => ((WORKFLOW_STATUSES as readonly string[]).includes(value) ? (value as WorkflowStatus) : 'draft')
const asRunStatus = (value: string): RunStatus => ((RUN_STATUSES as readonly string[]).includes(value) ? (value as RunStatus) : 'queued')
const asStepStatus = (value: string): StepStatus => ((STEP_STATUSES as readonly string[]).includes(value) ? (value as StepStatus) : 'running')

/** A stored graph as a definition (older or damaged drafts open as a blank workflow). */
export function readDefinition(schemaVersion: number, graph: Json): WorkflowDefinition {
  if (schemaVersion !== 2) return blankWorkflow()
  const normalized = normalizeDefinition(graph)
  return normalized.ok ? normalized.definition : blankWorkflow()
}

function readLayout(definition: WorkflowDefinition, layout: Json | null | undefined): WorkflowLayout {
  const parsed = workflowLayoutSchema.safeParse(layout ?? {})
  return reconcileLayout(definition, parsed.success ? parsed.data : {})
}

/** The employees, actions and connections the builder offers, read under the user's session. */
export async function getBuilderContext(organizationId: string) {
  return loadBuilderContext(await createUserClient(), organizationId)
}

export interface WorkflowListItem {
  id: string
  name: string
  description: string | null
  status: WorkflowStatus
  currentVersion: number | null
  draftSource: DraftSource
  lastRun: { status: RunStatus; at: string } | null
  updatedAt: string
}

export async function listWorkflows(organizationId: string): Promise<WorkflowListItem[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('workflow_definitions')
    .select('id, name, description, status, current_version_id, draft_source, updated_at')
    .eq('organization_id', organizationId)
    .order('updated_at', { ascending: false })
    .limit(200)
  if (error) fail('workflows', error)
  const versionIds = data.map((row) => row.current_version_id).filter((id): id is string => Boolean(id))
  const [versions, runs] = await Promise.all([
    versionIds.length ? supabase.from('workflow_versions').select('id, version').eq('organization_id', organizationId).in('id', versionIds) : Promise.resolve({ data: [], error: null }),
    data.length
      ? supabase
          .from('workflow_runs')
          .select('workflow_id, status, queued_at')
          .eq('organization_id', organizationId)
          .in('workflow_id', data.map((row) => row.id))
          .order('queued_at', { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (versions.error) fail('workflow versions', versions.error)
  if (runs.error) fail('workflow runs', runs.error)
  const numbers = new Map((versions.data ?? []).map((row) => [row.id, row.version]))
  const lastRuns = new Map<string, { status: RunStatus; at: string }>()
  for (const run of runs.data ?? []) if (!lastRuns.has(run.workflow_id)) lastRuns.set(run.workflow_id, { status: asRunStatus(run.status), at: run.queued_at })
  return data.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    status: asStatus(row.status),
    currentVersion: row.current_version_id ? (numbers.get(row.current_version_id) ?? null) : null,
    draftSource: row.draft_source as DraftSource,
    lastRun: lastRuns.get(row.id) ?? null,
    updatedAt: row.updated_at,
  }))
}

export interface VersionSummary {
  id: string
  version: number
  source: string
  createdAt: string
  publishedBy: string | null
  graphSha256: string
}

export interface WorkflowDetail {
  id: string
  name: string
  description: string | null
  status: WorkflowStatus
  lockVersion: number
  draft: WorkflowDefinition
  layout: WorkflowLayout
  draftSource: DraftSource
  generation: { notes: string[]; unsupported: string[]; generator: string | null } | null
  draftValidation: ValidationReport | null
  currentVersionId: string | null
  activatedAt: string | null
  versions: VersionSummary[]
  updatedAt: string
}

export async function getWorkflow(organizationId: string, workflowId: string): Promise<WorkflowDetail | null> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('workflow_definitions')
    .select('id, name, description, status, lock_version, draft_schema_version, draft_graph, draft_layout, draft_source, draft_generation, draft_validation, current_version_id, activated_at, updated_at')
    .eq('organization_id', organizationId)
    .eq('id', workflowId)
    .maybeSingle()
  if (error) fail('the workflow', error)
  if (!data) return null
  const { data: versions, error: versionsError } = await supabase
    .from('workflow_versions')
    .select('id, version, source, created_at, published_by, graph_sha256')
    .eq('organization_id', organizationId)
    .eq('workflow_id', workflowId)
    .order('version', { ascending: false })
    .limit(100)
  if (versionsError) fail('the workflow’s versions', versionsError)
  const draft = readDefinition(data.draft_schema_version, data.draft_graph)
  const generation = (data.draft_generation ?? null) as { notes?: unknown; unsupported?: unknown; generator?: unknown } | null
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    status: asStatus(data.status),
    lockVersion: data.lock_version,
    draft,
    layout: readLayout(draft, data.draft_layout),
    draftSource: data.draft_source as DraftSource,
    generation: generation
      ? {
          notes: Array.isArray(generation.notes) ? generation.notes.filter((note): note is string => typeof note === 'string') : [],
          unsupported: Array.isArray(generation.unsupported) ? generation.unsupported.filter((note): note is string => typeof note === 'string') : [],
          generator: typeof generation.generator === 'string' ? generation.generator : null,
        }
      : null,
    draftValidation: (data.draft_validation as ValidationReport | null) ?? null,
    currentVersionId: data.current_version_id,
    activatedAt: data.activated_at,
    versions: (versions ?? []).map((row) => ({ id: row.id, version: row.version, source: row.source, createdAt: row.created_at, publishedBy: row.published_by, graphSha256: row.graph_sha256 })),
    updatedAt: data.updated_at,
  }
}

export interface VersionDetail extends VersionSummary {
  workflowId: string
  definition: WorkflowDefinition
  layout: WorkflowLayout
  report: Record<string, unknown>
}

export async function getVersion(organizationId: string, workflowId: string, versionId: string): Promise<VersionDetail | null> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('workflow_versions')
    .select('id, workflow_id, version, source, created_at, published_by, graph_sha256, graph, graph_schema_version, layout, validation_report')
    .eq('organization_id', organizationId)
    .eq('workflow_id', workflowId)
    .eq('id', versionId)
    .maybeSingle()
  if (error) fail('the version', error)
  if (!data) return null
  const definition = readDefinition(data.graph_schema_version, data.graph)
  return {
    id: data.id,
    workflowId: data.workflow_id,
    version: data.version,
    source: data.source,
    createdAt: data.created_at,
    publishedBy: data.published_by,
    graphSha256: data.graph_sha256,
    definition,
    layout: readLayout(definition, data.layout),
    report: (data.validation_report ?? {}) as Record<string, unknown>,
  }
}

export interface RunListItem {
  id: string
  workflowId: string
  workflowName: string
  version: number | null
  status: RunStatus
  triggerType: string
  summary: string | null
  queuedAt: string
  finishedAt: string | null
}

export async function listRuns(organizationId: string, filter: { workflowId?: string } = {}, limit = 50): Promise<RunListItem[]> {
  const supabase = await createUserClient()
  let query = supabase
    .from('workflow_runs')
    .select('id, workflow_id, workflow_version_id, status, trigger_type, summary, queued_at, finished_at')
    .eq('organization_id', organizationId)
  if (filter.workflowId) query = query.eq('workflow_id', filter.workflowId)
  const { data, error } = await query.order('queued_at', { ascending: false }).limit(limit)
  if (error) fail('workflow runs', error)
  const workflowIds = [...new Set(data.map((row) => row.workflow_id))]
  const versionIds = [...new Set(data.map((row) => row.workflow_version_id))]
  const [workflows, versions] = await Promise.all([
    workflowIds.length ? supabase.from('workflow_definitions').select('id, name').eq('organization_id', organizationId).in('id', workflowIds) : Promise.resolve({ data: [], error: null }),
    versionIds.length ? supabase.from('workflow_versions').select('id, version').eq('organization_id', organizationId).in('id', versionIds) : Promise.resolve({ data: [], error: null }),
  ])
  const names = new Map((workflows.data ?? []).map((row) => [row.id, row.name]))
  const numbers = new Map((versions.data ?? []).map((row) => [row.id, row.version]))
  return data.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: names.get(row.workflow_id) ?? 'Workflow',
    version: numbers.get(row.workflow_version_id) ?? null,
    status: asRunStatus(row.status),
    triggerType: row.trigger_type,
    summary: row.summary,
    queuedAt: row.queued_at,
    finishedAt: row.finished_at,
  }))
}

export interface RunStep {
  nodeId: string
  nodeType: string
  label: string
  status: StepStatus
  branch: string | null
  attempt: number
  taskId: string | null
  taskStatus: string | null
  dueAt: string | null
  input: Json | null
  output: Json | null
  error: { code?: string; message?: string } | null
  startedAt: string
  finishedAt: string | null
}

export interface RunAction {
  id: string
  taskId: string
  toolKey: string
  risk: string
  status: string
  createdAt: string
}

export interface RunDetail {
  id: string
  workflowId: string
  workflowName: string
  versionId: string
  version: number | null
  definition: WorkflowDefinition
  layout: WorkflowLayout
  status: RunStatus
  triggerType: string
  input: Record<string, unknown>
  summary: string | null
  error: { code?: string; message?: string } | null
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  deadlineAt: string | null
  createdBy: string | null
  authorizedBy: string | null
  steps: RunStep[]
  actions: RunAction[]
  approvals: { id: string; kind: string; summary: string; status: string; requiredRole: string; expiresAt: string; taskId: string }[]
  events: { id: number; type: string; level: string; message: string | null; createdAt: string }[]
  costMicros: number
}

export async function getRun(organizationId: string, runId: string): Promise<RunDetail | null> {
  const supabase = await createUserClient()
  const { data: run, error } = await supabase
    .from('workflow_runs')
    .select('id, workflow_id, workflow_version_id, status, trigger_type, input, summary, error, queued_at, started_at, finished_at, deadline_at, created_by, authorized_by')
    .eq('organization_id', organizationId)
    .eq('id', runId)
    .maybeSingle()
  if (error) fail('the run', error)
  if (!run) return null
  const [workflow, version, steps, tasks, approvals, events] = await Promise.all([
    supabase.from('workflow_definitions').select('name').eq('organization_id', organizationId).eq('id', run.workflow_id).maybeSingle(),
    supabase.from('workflow_versions').select('version, graph, graph_schema_version, layout').eq('organization_id', organizationId).eq('id', run.workflow_version_id).maybeSingle(),
    supabase
      .from('workflow_run_steps')
      .select('node_id, node_type, label, status, branch, attempt, task_id, due_at, input, output, error, started_at, finished_at')
      .eq('organization_id', organizationId)
      .eq('run_id', runId)
      .order('started_at'),
    supabase.from('tasks').select('id, status, employee_id').eq('organization_id', organizationId).eq('workflow_run_id', runId),
    supabase
      .from('approval_requests')
      .select('id, kind, action_summary, status, required_role, expires_at, task_id')
      .eq('organization_id', organizationId)
      .eq('workflow_run_id', runId)
      .order('created_at'),
    supabase.from('execution_events').select('id, event_type, level, message, created_at').eq('organization_id', organizationId).eq('workflow_run_id', runId).order('id').limit(300),
  ])
  for (const result of [steps, tasks, approvals, events]) if (result.error) fail('the run’s history', result.error)
  const taskIds = (tasks.data ?? []).map((row) => row.id)
  const [actions, attempts] = await Promise.all([
    taskIds.length
      ? supabase.from('tool_executions').select('id, task_id, tool_key, risk_level, status, created_at').eq('organization_id', organizationId).in('task_id', taskIds).order('created_at')
      : Promise.resolve({ data: [], error: null }),
    taskIds.length ? supabase.from('task_attempts').select('cost_micros').eq('organization_id', organizationId).in('task_id', taskIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (actions.error) fail('the run’s actions', actions.error)
  const taskStatus = new Map((tasks.data ?? []).map((row) => [row.id, row.status]))
  const definition = version.data ? readDefinition(version.data.graph_schema_version, version.data.graph) : blankWorkflow()
  return {
    id: run.id,
    workflowId: run.workflow_id,
    workflowName: workflow.data?.name ?? 'Workflow',
    versionId: run.workflow_version_id,
    version: version.data?.version ?? null,
    definition,
    layout: readLayout(definition, version.data?.layout),
    status: asRunStatus(run.status),
    triggerType: run.trigger_type,
    input: (run.input ?? {}) as Record<string, unknown>,
    summary: run.summary,
    error: (run.error ?? null) as RunDetail['error'],
    queuedAt: run.queued_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    deadlineAt: run.deadline_at,
    createdBy: run.created_by,
    authorizedBy: run.authorized_by,
    steps: (steps.data ?? []).map((row) => ({
      nodeId: row.node_id,
      nodeType: row.node_type,
      label: row.label ?? row.node_id,
      status: asStepStatus(row.status),
      branch: row.branch,
      attempt: row.attempt,
      taskId: row.task_id,
      taskStatus: row.task_id ? (taskStatus.get(row.task_id) ?? null) : null,
      dueAt: row.due_at,
      input: row.input,
      output: row.output,
      error: (row.error ?? null) as RunStep['error'],
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
    actions: (actions.data ?? []).map((row) => ({ id: row.id, taskId: row.task_id, toolKey: row.tool_key, risk: row.risk_level, status: row.status, createdAt: row.created_at })),
    approvals: (approvals.data ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      summary: row.action_summary,
      status: row.status,
      requiredRole: row.required_role,
      expiresAt: row.expires_at,
      taskId: row.task_id,
    })),
    events: (events.data ?? []).map((row) => ({ id: row.id, type: row.event_type, level: row.level, message: row.message, createdAt: row.created_at })),
    costMicros: (attempts.data ?? []).reduce((sum, row) => sum + Number(row.cost_micros ?? 0), 0),
  }
}

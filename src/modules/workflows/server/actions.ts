'use server'

// Server Actions for workflows: creating a draft (from a description, a
// template or blank), saving the draft, activating a version, changing a
// workflow's status, restoring a version into the draft, and starting,
// cancelling and deleting.
//
// Each action confirms the session and the caller's role first; ids from the
// browser are validated and every query is scoped to the organization the
// caller is a verified member of. Drafts are saved under the user's own
// session (RLS: operators; optimistic locking on lock_version). Activation is
// for admins: the server validates the stored draft again with everything
// read from the database, then publishes it with the service role
// (publish_workflow_version re-checks the role, the lock and the typed name).
// Runs start and stop through SQL functions under the user's session.

import { randomUUID } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { isFeatureConfigured } from '@/lib/env/server'
import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { redact } from '@/lib/logging/redact'
import { createRateLimiter } from '@/lib/rate-limit'
import { getAdminClient } from '@/lib/supabase/admin'
import { createUserClient } from '@/lib/supabase/server'
import { hasMinRole, type Json, type OrganizationRole } from '@/lib/supabase/types'
import { getVerifiedUser, SESSION_ENDED_MESSAGE } from '@/modules/identity/server/session'
import { getVerifiedMember } from '@/modules/integrations/server/membership'
import { canRunIntegrations, getIntegrationRuntime } from '@/modules/integrations/server/runtime'
import { getModelGateway, isModelConfigured } from '@/modules/models/server/provider'
import { cancellationDisclosure } from '@/modules/tasks/domain/task-center'

import { autoLayout, blankWorkflow, getWorkflowTemplate } from '../domain/factory'
import { issuesOf, runInputSchema, workflowDefinitionSchema, workflowLayoutSchema, workflowMetaSchema } from '../domain/schemas'
import { GRAPH_SCHEMA_VERSION, WORKFLOW_BOUNDS, type WorkflowDefinition } from '../domain/types'
import { validateWorkflow, type ValidationReport } from '../domain/validation'
import { loadBuilderContext } from './context'
import { generateWorkflow, MAX_DESCRIPTION_CHARS } from './generation'
import { readDefinition } from './queries'
import { scheduleWorkflowProcessing } from './scheduling'
import { checkForActivation, type ActivationCheck } from './validation'

const NOT_ALLOWED = 'You don’t have permission to do that in this workspace.'
const generateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 })
const runLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 })
const uuid = z.uuid()

function readUuid(value: unknown): string | null {
  const parsed = uuid.safeParse(value)
  return parsed.success ? parsed.data : null
}

async function member(organizationId: string, minimum: OrganizationRole) {
  const check = await getVerifiedMember(organizationId)
  if (check.status === 'signed_out') return { ok: false as const, message: SESSION_ENDED_MESSAGE, code: 'session_ended' }
  if (check.status !== 'ok' || !hasMinRole(check.role, minimum)) {
    const message =
      check.status === 'ok' && minimum === 'admin'
        ? 'Only admins and owners can activate workflows.'
        : check.status === 'ok' && minimum === 'operator'
          ? 'Viewers can’t change workflows. Ask an operator or admin.'
          : NOT_ALLOWED
    return { ok: false as const, message, code: undefined }
  }
  return { ok: true as const, user: check.user, role: check.role }
}

function refresh(workflowId?: string) {
  revalidatePath('/app/workflows')
  if (workflowId) revalidatePath(`/app/workflows/${workflowId}`)
}

// --- Creating -------------------------------------------------------------------

const createSchema = z.object({
  organizationId: z.uuid(),
  mode: z.enum(['describe', 'template', 'blank']),
  name: z.string().trim().max(WORKFLOW_BOUNDS.name).optional(),
  description: z.string().trim().max(MAX_DESCRIPTION_CHARS, `Keep the description under ${MAX_DESCRIPTION_CHARS} characters.`).optional(),
  templateKey: z.string().max(60).optional(),
})

export async function createWorkflowAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError('Check the form and try again.', z.flattenError(parsed.error).fieldErrors)
  const { organizationId, mode } = parsed.data
  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return actionError(caller.message, undefined, caller.code)

  const supabase = await createUserClient()
  const context = await loadBuilderContext(supabase, organizationId)
  let name = parsed.data.name || 'New workflow'
  let description = ''
  let definition: WorkflowDefinition
  let source: 'manual' | 'ai_generated' | 'rules' | 'template' = 'manual'
  let generation: Record<string, unknown> | null = null

  if (mode === 'describe') {
    const text = parsed.data.description ?? ''
    if (text.length < 15) return actionError('Describe the workflow in a sentence or two.', { description: ['Describe what should happen, in order.'] })
    if (!generateLimiter(caller.user.id)) return actionError('Too many drafts in a short time. Wait a minute and try again.')
    const generated = await generateWorkflow(text, context, isModelConfigured() ? getModelGateway() : null)
    name = parsed.data.name || generated.name
    description = generated.description
    definition = generated.definition
    source = generated.source
    generation = { ...generated.metadata, notes: generated.notes, unsupported: generated.unsupported }
  } else if (mode === 'template') {
    const template = getWorkflowTemplate(parsed.data.templateKey ?? '')
    if (!template) return actionError('That template doesn’t exist.')
    const active = context.employees.filter((employee) => employee.status === 'active' && employee.activeVersionId)
    const connectionFor = (provider: string) => {
      const candidates = context.connections.filter((connection) => connection.provider === provider && connection.status === 'connected')
      return candidates.length === 1 ? candidates[0]!.id : null
    }
    definition = template.build({ employeeId: active.length === 1 ? active[0]!.id : null, connectionFor })
    name = parsed.data.name || template.name
    description = template.summary
    source = 'template'
    generation = { generator: 'template', template: template.key, notes: [`Started from the “${template.name}” template. Choose an employee and connections where they’re missing, then review every step.`], unsupported: [] }
  } else {
    definition = blankWorkflow()
  }

  const report = validateWorkflow(definition, { mode: 'draft', context })
  let attempt = 0
  for (;;) {
    const candidate = attempt === 0 ? name : `${name} (${attempt + 1})`
    const { data, error } = await supabase
      .from('workflow_definitions')
      .insert({
        organization_id: organizationId,
        name: candidate.slice(0, WORKFLOW_BOUNDS.name),
        description: description || null,
        draft_schema_version: GRAPH_SCHEMA_VERSION,
        draft_graph: definition as unknown as Json,
        draft_layout: autoLayout(definition) as unknown as Json,
        draft_source: source,
        draft_generation: generation as Json,
        draft_validation: report as unknown as Json,
      })
      .select('id')
      .single()
    if (data) {
      refresh()
      redirect(`/app/workflows/${data.id}`)
    }
    if (error?.code === '23505' && attempt < 5) {
      attempt++
      continue
    }
    if (error?.code === '23514') return actionError('The workflow was refused: it may contain something that looks like a password, token or API key.')
    console.error('[workflows] creating a workflow failed', redact({ code: error?.code }))
    return actionError('The workflow couldn’t be created. Please try again.')
  }
}

// --- Saving the draft ---------------------------------------------------------------

export type SaveDraftResult =
  | { status: 'saved'; lockVersion: number; report: ValidationReport }
  | { status: 'error'; message: string; code?: 'conflict' | 'session_ended'; issues?: { path: string; message: string }[] }

export async function saveWorkflowDraftAction(input: {
  organizationId: string
  workflowId: string
  lockVersion: number
  name: string
  description: string
  definition: unknown
  layout: unknown
}): Promise<SaveDraftResult> {
  const organizationId = readUuid(input.organizationId)
  const workflowId = readUuid(input.workflowId)
  if (!organizationId || !workflowId || !Number.isInteger(input.lockVersion)) return { status: 'error', message: NOT_ALLOWED }
  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return { status: 'error', message: caller.message, ...(caller.code ? { code: 'session_ended' as const } : {}) }
  if (JSON.stringify(input.definition ?? null).length > 200_000) return { status: 'error', message: 'This workflow is too large to save.' }

  const meta = workflowMetaSchema.safeParse({ name: input.name, description: input.description })
  if (!meta.success) return { status: 'error', message: meta.error.issues[0]?.message ?? 'Check the name.', issues: issuesOf(meta.error) }
  const definition = workflowDefinitionSchema.safeParse(input.definition)
  if (!definition.success) return { status: 'error', message: 'Some step settings are out of range or missing.', issues: issuesOf(definition.error) }
  const layout = workflowLayoutSchema.safeParse(input.layout ?? {})

  const supabase = await createUserClient()
  const context = await loadBuilderContext(supabase, organizationId)
  const report = validateWorkflow(definition.data, { mode: 'draft', context })
  const { data, error } = await supabase
    .from('workflow_definitions')
    .update({
      name: meta.data.name,
      description: meta.data.description || null,
      draft_schema_version: GRAPH_SCHEMA_VERSION,
      draft_graph: definition.data as unknown as Json,
      draft_layout: (layout.success ? layout.data : autoLayout(definition.data)) as unknown as Json,
      draft_validation: report as unknown as Json,
    })
    .eq('id', workflowId)
    .eq('organization_id', organizationId)
    .eq('lock_version', input.lockVersion)
    .select('lock_version')
  if (error) {
    if (error.code === '23505') return { status: 'error', message: 'Another workflow in this workspace already has that name.' }
    if (error.code === '23514') return { status: 'error', message: 'The draft was refused: it may contain something that looks like a password, token or API key.' }
    console.error('[workflows] saving a draft failed', redact({ code: error.code }))
    return { status: 'error', message: 'The draft couldn’t be saved. Please try again.' }
  }
  if (!data?.length) return { status: 'error', code: 'conflict', message: 'Someone else saved this workflow while you were editing. Reload to see their changes, then reapply yours.' }
  refresh(workflowId)
  return { status: 'saved', lockVersion: data[0]!.lock_version, report }
}

// --- Activating ------------------------------------------------------------------------

export type ActivateResult =
  | { status: 'activated'; version: number; lockVersion: number }
  | { status: 'invalid'; report: ActivationCheck['report'] }
  | { status: 'error'; message: string; code?: 'conflict' | 'session_ended' }

const ACTIVATE_ERRORS: Record<string, string> = {
  P0002: 'Only admins and owners can activate workflows.',
  '55000': 'Archived workflows can’t be activated. Restore it first.',
  '40001': 'The draft changed since you last saved it. Save or reload, then activate again.',
  '22023': 'Type the workflow’s name exactly to confirm.',
  '23514': 'The database refused this graph. Check the workflow for problems and try again.',
}

export async function activateWorkflowAction(input: { organizationId: string; workflowId: string; lockVersion: number; confirmName: string }): Promise<ActivateResult> {
  const organizationId = readUuid(input.organizationId)
  const workflowId = readUuid(input.workflowId)
  if (!organizationId || !workflowId || !Number.isInteger(input.lockVersion)) return { status: 'error', message: NOT_ALLOWED }
  const caller = await member(organizationId, 'admin')
  if (!caller.ok) return { status: 'error', message: caller.message, ...(caller.code ? { code: 'session_ended' as const } : {}) }
  if (!isFeatureConfigured('supabaseAdmin')) return { status: 'error', message: 'Activation needs the Supabase secret key on this deployment.' }

  // The stored draft is what gets validated and activated, never the browser's copy.
  const supabase = await createUserClient()
  const { data: workflow, error } = await supabase
    .from('workflow_definitions')
    .select('id, name, lock_version, draft_schema_version, draft_graph, draft_layout')
    .eq('id', workflowId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error || !workflow) return { status: 'error', message: 'That workflow doesn’t exist in this workspace.' }
  if (workflow.lock_version !== input.lockVersion) return { status: 'error', code: 'conflict', message: ACTIVATE_ERRORS['40001']! }
  if (input.confirmName.trim().toLowerCase() !== workflow.name.trim().toLowerCase()) return { status: 'error', message: ACTIVATE_ERRORS['22023']! }
  const parsed = workflow.draft_schema_version === GRAPH_SCHEMA_VERSION ? workflowDefinitionSchema.safeParse(workflow.draft_graph) : null
  if (!parsed?.success) return { status: 'error', message: 'Save the draft again before activating it (its format is out of date or incomplete).' }

  const admin = getAdminClient()
  const context = await loadBuilderContext(admin, organizationId)
  const check = await checkForActivation(parsed.data, context, {
    admin,
    integrations: canRunIntegrations() ? getIntegrationRuntime() : null,
    organizationId,
    now: new Date(),
  })
  if (!check.report.valid) return { status: 'invalid', report: check.report }

  const layout = workflowLayoutSchema.safeParse(workflow.draft_layout ?? {})
  const { data, error: publishError } = await admin.rpc('publish_workflow_version', {
    p_workflow_id: workflowId,
    p_actor: caller.user.id,
    p_expected_lock_version: input.lockVersion,
    p_confirm_name: input.confirmName,
    p_graph: check.graph as unknown as Json,
    p_layout: (layout.success ? layout.data : autoLayout(check.graph)) as unknown as Json,
    p_report: check.report as unknown as Json,
    ...(check.schedule ? { p_schedule: check.schedule as unknown as Json } : {}),
  })
  if (publishError || !data) {
    const message = (publishError?.code && ACTIVATE_ERRORS[publishError.code]) ?? null
    if (!message) console.error('[workflows] activating a workflow failed', redact({ code: publishError?.code }))
    return { status: 'error', message: message ?? 'The workflow couldn’t be activated. Please try again.', ...(publishError?.code === '40001' ? { code: 'conflict' as const } : {}) }
  }
  const result = data as { version: number; lock_version: number }
  refresh(workflowId)
  return { status: 'activated', version: result.version, lockVersion: result.lock_version }
}

// --- Status and versions ------------------------------------------------------------------

const STATUS_ERRORS: Record<string, string> = {
  P0002: 'Your role can’t do that (pausing needs an operator; resuming, archiving and restoring need an admin).',
  '55000': 'The workflow’s status changed. Reload the page.',
}

export async function changeWorkflowStatusAction(workflowId: string, action: 'pause' | 'resume' | 'archive' | 'restore'): Promise<ActionState> {
  if (!readUuid(workflowId) || !['pause', 'resume', 'archive', 'restore'].includes(action)) return actionError(NOT_ALLOWED)
  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')
  const { data, error } = await supabase.rpc('change_workflow_status', { p_workflow_id: workflowId, p_action: action })
  if (error) {
    const message = (error.code && STATUS_ERRORS[error.code]) ?? null
    if (!message) console.error('[workflows] changing a workflow’s status failed', redact({ code: error.code }))
    return actionError(message ?? 'The status couldn’t be changed. Please try again.')
  }
  if (action === 'resume') scheduleWorkflowProcessing({ reason: 'workflow_resumed' })
  refresh(workflowId)
  const messages: Record<string, string> = {
    paused: 'Paused. No new runs start; runs already going continue.',
    active: 'Active again. Runs can start and schedules resume.',
    archived: 'Archived. Its history is kept.',
    draft: 'Restored as a draft.',
  }
  return actionSuccess(messages[data] ?? 'Done.')
}

export async function restoreVersionAction(input: { organizationId: string; workflowId: string; versionId: string; lockVersion: number }): Promise<SaveDraftResult> {
  const organizationId = readUuid(input.organizationId)
  const workflowId = readUuid(input.workflowId)
  const versionId = readUuid(input.versionId)
  if (!organizationId || !workflowId || !versionId) return { status: 'error', message: NOT_ALLOWED }
  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return { status: 'error', message: caller.message }
  const supabase = await createUserClient()
  const { data: version } = await supabase
    .from('workflow_versions')
    .select('graph, graph_schema_version, layout')
    .eq('id', versionId)
    .eq('workflow_id', workflowId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (!version) return { status: 'error', message: 'That version doesn’t exist.' }
  const definition = readDefinition(version.graph_schema_version, version.graph)
  // Employee versions are pinned again at the next activation.
  const draft: WorkflowDefinition = {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.type !== 'employee_task') return node
      const { employeeVersionId: _pinned, ...config } = node.config
      return { ...node, config }
    }),
  }
  const context = await loadBuilderContext(supabase, organizationId)
  const report = validateWorkflow(draft, { mode: 'draft', context })
  const { data, error } = await supabase
    .from('workflow_definitions')
    .update({ draft_graph: draft as unknown as Json, draft_layout: version.layout, draft_schema_version: GRAPH_SCHEMA_VERSION, draft_validation: report as unknown as Json })
    .eq('id', workflowId)
    .eq('organization_id', organizationId)
    .eq('lock_version', input.lockVersion)
    .select('lock_version')
  if (error) return { status: 'error', message: 'The version couldn’t be restored. Please try again.' }
  if (!data?.length) return { status: 'error', code: 'conflict', message: 'The draft changed since you opened it. Reload and try again.' }
  refresh(workflowId)
  return { status: 'saved', lockVersion: data[0]!.lock_version, report }
}

export async function deleteWorkflowAction(organizationId: string, workflowId: string): Promise<ActionState> {
  if (!readUuid(organizationId) || !readUuid(workflowId)) return actionError(NOT_ALLOWED)
  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return actionError(caller.message, undefined, caller.code)
  const supabase = await createUserClient()
  const { data, error } = await supabase.from('workflow_definitions').delete().eq('id', workflowId).eq('organization_id', organizationId).select('id')
  if (error) {
    console.error('[workflows] deleting a workflow failed', redact({ code: error.code }))
    return actionError('The workflow couldn’t be deleted. Please try again.')
  }
  if (!data?.length) return actionError('Only a workflow that was never activated can be deleted. Archive it instead; its history is kept.')
  refresh()
  redirect('/app/workflows')
}

// --- Runs ---------------------------------------------------------------------------------------

const RUN_ERRORS: Record<string, string> = {
  P0002: 'That workflow doesn’t exist in this workspace, or your role can’t start runs.',
  '55000': 'Only an active workflow can run.',
  '22023': 'The inputs don’t match what the workflow expects.',
  '23514': 'The inputs contain something that looks like a password, token or API key.',
}

export async function startRunAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const workflowId = readUuid(formData.get('workflowId'))
  const organizationId = readUuid(formData.get('organizationId'))
  if (!workflowId || !organizationId) return actionError(NOT_ALLOWED)
  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return actionError(caller.message, undefined, caller.code)
  if (!runLimiter(caller.user.id)) return actionError('Many runs in a short time. Wait a minute and try again.')

  const supabase = await createUserClient()
  const { data: workflow } = await supabase.from('workflow_definitions').select('current_version_id, status').eq('id', workflowId).eq('organization_id', organizationId).maybeSingle()
  if (!workflow?.current_version_id || workflow.status !== 'active') return actionError(RUN_ERRORS['55000']!)
  const { data: version } = await supabase.from('workflow_versions').select('graph, graph_schema_version').eq('id', workflow.current_version_id).eq('organization_id', organizationId).maybeSingle()
  if (!version) return actionError(RUN_ERRORS['55000']!)
  const definition = readDefinition(version.graph_schema_version, version.graph)

  const raw: Record<string, unknown> = {}
  for (const input of definition.inputs) {
    const value = formData.get(`input.${input.key}`)
    raw[input.key] = input.type === 'boolean' ? value === 'on' || value === 'true' : typeof value === 'string' ? value : undefined
  }
  const parsed = runInputSchema(definition.inputs).safeParse(raw)
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {}
    for (const issue of parsed.error.issues) fieldErrors[`input.${String(issue.path[0] ?? '')}`] = [issue.message]
    return actionError('Check the inputs and try again.', fieldErrors)
  }
  const requestKey = formData.get('requestKey')
  const { data, error } = await supabase.rpc('start_workflow_run', {
    p_workflow_id: workflowId,
    p_input: parsed.data as Json,
    p_idempotency_key: typeof requestKey === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(requestKey) ? requestKey : randomUUID(),
  })
  if (error || !data) {
    const message = (error?.code && RUN_ERRORS[error.code]) ?? null
    if (!message) console.error('[workflows] starting a run failed', redact({ code: error?.code }))
    return actionError(message ?? 'The run couldn’t be started. Please try again.')
  }
  scheduleWorkflowProcessing({ reason: 'run_started', runId: data })
  refresh(workflowId)
  redirect(`/app/workflows/runs/${data}`)
}

export async function cancelRunAction(runId: string): Promise<ActionState> {
  if (!readUuid(runId)) return actionError(NOT_ALLOWED)
  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')
  const { error } = await supabase.rpc('cancel_workflow_run', { p_run_id: runId })
  if (error) {
    const message = error.code === 'P0002' ? 'That run doesn’t exist here, or your role can’t cancel it.' : error.code === '55000' ? 'This run has already finished.' : null
    if (!message) console.error('[workflows] cancelling a run failed', redact({ code: error.code }))
    return actionError(message ?? 'The run couldn’t be cancelled. Please try again.')
  }
  const { data: tasks } = await supabase.from('tasks').select('id').eq('workflow_run_id', runId)
  const taskIds = (tasks ?? []).map((task) => task.id)
  const { data: actions } = taskIds.length ? await supabase.from('tool_executions').select('id, tool_key, risk_level, status').in('task_id', taskIds) : { data: [] }
  const disclosure = cancellationDisclosure((actions ?? []).map((row) => ({ id: row.id, toolKey: row.tool_key, risk: row.risk_level, status: row.status })))
  const parts = ['Cancelled. No further steps start; a step an employee is working on stops after its current step.']
  if (disclosure.done.length) {
    parts.push(`${disclosure.done.length} action${disclosure.done.length === 1 ? '' : 's'} had already been carried out (${[...new Set(disclosure.done.map((action) => action.toolKey))].join(', ')}) and can’t be undone by cancelling.`)
  }
  if (disclosure.inProgress.length) parts.push(`${disclosure.inProgress.length} action${disclosure.inProgress.length === 1 ? ' was' : 's were'} running and may still complete.`)
  revalidatePath(`/app/workflows/runs/${runId}`)
  return actionSuccess(parts.join(' '))
}

'use server'

// Server Actions for AI employees: drafting, saving versions, status changes
// (including activation), test cases, test runs and reviews.
//
// Each action confirms the session and the caller's role in the workspace
// before doing anything; organization and employee ids from the browser are
// validated and every query is scoped to the organization the caller is a
// verified member of. Saving and status changes run under the user's own
// session, so RLS and the SQL functions (create_employee,
// save_employee_version, change_employee_status) repeat the checks. Test runs
// use the service role (they record runs and usage) after the role check.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { FeatureUnavailableError, isFeatureConfigured } from '@/lib/env/server'
import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { redact } from '@/lib/logging/redact'
import { createRateLimiter } from '@/lib/rate-limit'
import { getAdminClient } from '@/lib/supabase/admin'
import { createUserClient } from '@/lib/supabase/server'
import { hasMinRole, type Json, type OrganizationRole } from '@/lib/supabase/types'
import { SESSION_ENDED_MESSAGE } from '@/modules/identity/server/session'
import { getVerifiedMember } from '@/modules/integrations/server/membership'
import { getIntegrationRuntime } from '@/modules/integrations/server/runtime'
import { getEmbedder } from '@/modules/knowledge/server/embeddings'
import { getModelGateway, isModelConfigured } from '@/modules/models/server/provider'

import { ACTION_MIN_ROLE, LIFECYCLE_ACTIONS, type LifecycleAction } from '../domain/lifecycle'
import { employeeConfigSchema, employeeDraftSchema, issuesOf, testCaseSchema } from '../domain/schemas'
import { buildTemplateDraft, getTemplate } from '../domain/templates'
import type { CheckResult } from '../domain/test-checks'
import type { EmployeeDraft, RunOutcome, TestRunResult } from '../domain/types'
import { activationBlockers, validateConfig, type ConfigIssue } from '../domain/validation'
import { connectionPicker, draftEmployee, MAX_DESCRIPTION_CHARS, type DraftSource } from './drafting'
import { runEmployeeTest } from './playground'
import { loadEditorOptions } from './queries'
import type { TranscriptEntry } from './runtime'
import { listEmployeeTools } from './tools'

const NOT_ALLOWED = 'You don’t have permission to do that in this workspace.'
const MAX_DRAFT_BYTES = 100_000

const draftLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 })
const testLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 })

const uuid = z.uuid()

function readUuid(value: unknown): string | null {
  const parsed = uuid.safeParse(value)
  return parsed.success ? parsed.data : null
}

function refresh(employeeId?: string) {
  revalidatePath('/app/employees')
  if (employeeId) {
    revalidatePath(`/app/employees/${employeeId}`)
    revalidatePath(`/app/employees/${employeeId}/playground`)
  }
}

async function member(organizationId: string, minimum: OrganizationRole) {
  const check = await getVerifiedMember(organizationId)
  if (check.status === 'signed_out') return { ok: false as const, message: SESSION_ENDED_MESSAGE, code: 'session_ended' }
  if (check.status !== 'ok' || !hasMinRole(check.role, minimum)) {
    const message =
      check.status === 'ok' && minimum === 'admin'
        ? 'Only admins and owners can do that.'
        : check.status === 'ok' && minimum === 'operator'
          ? 'Viewers can’t change employees. Ask an operator or admin.'
          : NOT_ALLOWED
    return { ok: false as const, message, code: undefined }
  }
  return { ok: true as const, user: check.user, role: check.role }
}

// --- Drafting -----------------------------------------------------------------

export type DraftState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'ready'; draft: EmployeeDraft; source: DraftSource | 'template'; notes: string[]; unsupported: string[]; nonce: string }

export async function draftEmployeeAction(_previous: DraftState, formData: FormData): Promise<DraftState> {
  const organizationId = readUuid(formData.get('organizationId'))
  if (!organizationId) return { status: 'error', message: NOT_ALLOWED }
  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return { status: 'error', message: caller.message }

  const catalog = listEmployeeTools()
  const options = await loadEditorOptions(organizationId)
  const connectionFor = connectionPicker(options.connections)
  const nonce = crypto.randomUUID()

  const templateKey = formData.get('templateKey')
  if (typeof templateKey === 'string' && templateKey) {
    const template = getTemplate(templateKey)
    if (!template) return { status: 'error', message: 'That template doesn’t exist.' }
    return {
      status: 'ready',
      draft: buildTemplateDraft(template, catalog, connectionFor),
      source: 'template',
      notes: [`Started from the “${template.name}” template. Review every field.`],
      unsupported: template.limitations,
      nonce,
    }
  }

  const description = formData.get('description')
  if (typeof description !== 'string' || description.trim().length < 10) return { status: 'error', message: 'Describe the employee in a sentence or two.' }
  if (description.length > MAX_DESCRIPTION_CHARS) return { status: 'error', message: `Keep the description under ${MAX_DESCRIPTION_CHARS} characters.` }
  if (!draftLimiter(caller.user.id)) return { status: 'error', message: 'Too many drafts in a short time. Wait a minute and try again.' }

  const gateway = isModelConfigured() ? getModelGateway() : null
  const result = await draftEmployee(description, catalog, options.connections, gateway)
  return { status: 'ready', draft: result.draft, source: result.source, notes: result.notes, unsupported: result.unsupported, nonce }
}

// --- Saving ---------------------------------------------------------------------

export type SaveState =
  | { status: 'idle' }
  | { status: 'error'; message: string; issues?: ConfigIssue[] }

const SAVE_ERRORS: Record<string, string> = {
  '23505': 'Another employee in this workspace already has that name.',
  '40001': 'Someone saved a newer version while you were editing. Reload to see it, then reapply your changes.',
  '55000': 'Archived employees can’t be edited. Restore it first.',
  '42501': 'Viewers can’t change employees. Ask an operator or admin.',
  P0002: 'That employee doesn’t exist in this workspace.',
  '23514': 'The configuration was refused: it may contain something that looks like a password, token or API key.',
}

export async function saveEmployeeAction(_previous: SaveState, formData: FormData): Promise<SaveState> {
  const organizationId = readUuid(formData.get('organizationId'))
  const employeeIdRaw = formData.get('employeeId')
  const employeeId = employeeIdRaw ? readUuid(employeeIdRaw) : null
  const basedOn = formData.get('basedOnVersionId') ? readUuid(formData.get('basedOnVersionId')) : null
  const rawDraft = formData.get('draft')
  const changeNote = typeof formData.get('changeNote') === 'string' ? String(formData.get('changeNote')).trim().slice(0, 1000) : ''
  if (!organizationId || (employeeIdRaw && !employeeId) || (employeeId && !basedOn)) return { status: 'error', message: NOT_ALLOWED }
  if (typeof rawDraft !== 'string' || rawDraft.length > MAX_DRAFT_BYTES) return { status: 'error', message: 'The configuration is too large to save.' }

  let json: unknown
  try {
    json = JSON.parse(rawDraft)
  } catch {
    return { status: 'error', message: 'The configuration couldn’t be read. Reload and try again.' }
  }
  const parsed = employeeDraftSchema.safeParse(json)
  if (!parsed.success) return { status: 'error', message: 'Some fields need attention.', issues: issuesOf(parsed.error) }

  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return { status: 'error', message: caller.message }

  const options = await loadEditorOptions(organizationId)
  const { errors } = validateConfig(parsed.data.config, { tools: listEmployeeTools(), ...options })
  if (errors.length) return { status: 'error', message: 'Some fields need attention.', issues: errors }

  const supabase = await createUserClient()
  const config = parsed.data.config as unknown as Json
  let savedId = employeeId
  if (!employeeId) {
    const { data, error } = await supabase.rpc('create_employee', {
      p_organization_id: organizationId,
      p_instructions: parsed.data.instructions,
      p_config: config,
      ...(changeNote ? { p_change_note: changeNote } : { p_change_note: 'First version' }),
    })
    if (error) return saveFailure(error)
    savedId = data
  } else {
    const { error } = await supabase.rpc('save_employee_version', {
      p_employee_id: employeeId,
      p_based_on_version_id: basedOn!,
      p_instructions: parsed.data.instructions,
      p_config: config,
      ...(changeNote ? { p_change_note: changeNote } : {}),
    })
    if (error) return saveFailure(error)
  }

  refresh(savedId ?? undefined)
  redirect(`/app/employees/${savedId}?saved=1`)
}

function saveFailure(error: { code?: string }): SaveState {
  const message = (error.code && SAVE_ERRORS[error.code]) ?? null
  if (!message) console.error('[employees] saving an employee failed', redact({ code: error.code }))
  return { status: 'error', message: message ?? 'The employee couldn’t be saved. Please try again.' }
}

// --- Status changes ---------------------------------------------------------------

const STATUS_ERRORS: Record<string, string> = {
  P0002: 'That employee doesn’t exist, or your role can’t make this change.',
  '55000': 'That change isn’t possible from the employee’s current state.',
  '40001': 'A newer version was saved. Reload and review it before activating.',
  '22023': 'Type the employee’s name exactly to confirm.',
  '23514': 'The version’s tests haven’t all passed. Run them in the playground first.',
  '23503': 'A connection this version uses no longer exists. Edit the employee and choose another.',
}

export async function changeEmployeeStatus(
  organizationId: string,
  employeeId: string,
  action: string,
  options: { versionId?: string; confirmName?: string } = {},
): Promise<ActionState> {
  const org = readUuid(organizationId)
  const id = readUuid(employeeId)
  if (!org || !id || !(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) return actionError(NOT_ALLOWED)
  const lifecycleAction = action as LifecycleAction
  const versionId = options.versionId === undefined ? undefined : readUuid(options.versionId)
  if (versionId === null) return actionError(NOT_ALLOWED)

  const caller = await member(org, ACTION_MIN_ROLE[lifecycleAction])
  if (!caller.ok) return actionError(caller.message, undefined, caller.code)

  const supabase = await createUserClient()
  if (lifecycleAction === 'activate') {
    if (!versionId || !options.confirmName?.trim()) return actionError('Type the employee’s name to confirm.')
    // Connections must be chosen and connected before an employee can be given real work.
    const { data: version, error } = await supabase
      .from('employee_versions')
      .select('config, config_schema_version')
      .eq('id', versionId)
      .eq('employee_id', id)
      .eq('organization_id', org)
      .maybeSingle()
    if (error) return actionError('The version couldn’t be loaded. Please try again.')
    const config = version?.config_schema_version === 2 ? employeeConfigSchema.safeParse(version.config) : null
    if (!config?.success) return actionError('This version can’t be activated: save it again in the editor first.')
    const blockers = activationBlockers(config.data, { tools: listEmployeeTools(), ...(await loadEditorOptions(org)) })
    if (blockers.length) return actionError(`Fix these before activating: ${blockers.map((issue) => issue.message).join(' ')}`)
  }

  const { error } = await supabase.rpc('change_employee_status', {
    p_employee_id: id,
    p_action: lifecycleAction,
    ...(versionId ? { p_version_id: versionId } : {}),
    ...(options.confirmName ? { p_confirm_name: options.confirmName } : {}),
  })
  if (error) {
    const message = (error.code && STATUS_ERRORS[error.code]) ?? null
    if (!message) console.error('[employees] changing status failed', redact({ code: error.code, action: lifecycleAction }))
    return actionError(message ?? 'The change couldn’t be saved. Please try again.')
  }
  refresh(id)
  const done: Record<LifecycleAction, string> = {
    start_testing: 'Moved to testing. Use the playground to run tests.',
    return_to_draft: 'Moved back to draft.',
    activate: 'Activated. This version is now the one that runs, with exactly the tools and approval rules it lists.',
    pause: 'Paused. Nothing will run until it is resumed.',
    resume: 'Resumed.',
    archive: 'Archived. Its history is kept.',
    restore: 'Restored as a draft. Test and activate it again to use it.',
  }
  return actionSuccess(done[lifecycleAction])
}

export async function deleteEmployeeDraft(organizationId: string, employeeId: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const id = readUuid(employeeId)
  if (!org || !id) return actionError(NOT_ALLOWED)
  const caller = await member(org, 'operator')
  if (!caller.ok) return actionError(caller.message, undefined, caller.code)

  const supabase = await createUserClient()
  // RLS deletes only drafts that were never activated.
  const { data, error } = await supabase.from('ai_employees').delete().eq('id', id).eq('organization_id', org).select('id')
  if (error) {
    console.error('[employees] deleting a draft failed', redact({ code: error.code }))
    return actionError('The draft couldn’t be deleted. Please try again.')
  }
  if (!data.length) return actionError('Only drafts that were never activated can be deleted. Archive this employee instead.')
  revalidatePath('/app/employees')
  redirect('/app/employees')
}

// --- Test cases ---------------------------------------------------------------------

function lines(value: FormDataEntryValue | null): string[] {
  return typeof value === 'string'
    ? value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

export async function saveTestCaseAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const organizationId = readUuid(formData.get('organizationId'))
  const employeeId = readUuid(formData.get('employeeId'))
  const testCaseId = formData.get('testCaseId') ? readUuid(formData.get('testCaseId')) : undefined
  if (!organizationId || !employeeId || testCaseId === null) return actionError(NOT_ALLOWED)

  const known = new Set(listEmployeeTools().map((tool) => tool.key))
  const tools = (name: string) => formData.getAll(name).filter((value): value is string => typeof value === 'string' && known.has(value))
  const parsed = testCaseSchema.safeParse({
    name: formData.get('name'),
    input: formData.get('input'),
    expectations: {
      mustUseTools: tools('mustUseTools'),
      mustNotUseTools: tools('mustNotUseTools'),
      mustRequestApproval: tools('mustRequestApproval'),
      replyMustMention: lines(formData.get('replyMustMention')),
      mustEscalate: formData.get('mustEscalate') === 'on',
    },
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {}
    for (const issue of parsed.error.issues) (fieldErrors[String(issue.path[0] ?? 'form')] ??= []).push(issue.message)
    return actionError('Check the highlighted fields.', fieldErrors)
  }

  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return actionError(caller.message, undefined, caller.code)

  const expectations = Object.fromEntries(
    Object.entries(parsed.data.expectations).filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value === true)),
  ) as Json
  const supabase = await createUserClient()
  const values = { name: parsed.data.name, input: parsed.data.input, expectations }
  const { error } = testCaseId
    ? await supabase.from('employee_test_cases').update(values).eq('id', testCaseId).eq('employee_id', employeeId).eq('organization_id', organizationId)
    : await supabase.from('employee_test_cases').insert({ ...values, organization_id: organizationId, employee_id: employeeId })
  if (error) {
    if (error.code === '23505') return actionError('Another test case for this employee has that name.', { name: ['Choose a different name.'] })
    if (error.code === '23514') return actionError('The test was refused: it may contain something that looks like a password, token or API key.')
    if (error.code === '42501') return actionError('Viewers can’t change test cases.')
    console.error('[employees] saving a test case failed', redact({ code: error.code }))
    return actionError('The test case couldn’t be saved. Please try again.')
  }
  refresh(employeeId)
  return actionSuccess(testCaseId ? 'Test case saved.' : 'Test case added. Run it on the latest version.')
}

export async function deleteTestCase(organizationId: string, employeeId: string, testCaseId: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const employee = readUuid(employeeId)
  const id = readUuid(testCaseId)
  if (!org || !employee || !id) return actionError(NOT_ALLOWED)
  const caller = await member(org, 'operator')
  if (!caller.ok) return actionError(caller.message, undefined, caller.code)
  const supabase = await createUserClient()
  const { error } = await supabase.from('employee_test_cases').delete().eq('id', id).eq('employee_id', employee).eq('organization_id', org)
  if (error) return actionError('The test case couldn’t be deleted. Please try again.')
  refresh(employee)
  return actionSuccess('Test case deleted.')
}

// --- Test runs ------------------------------------------------------------------------

export type TestRunState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'done'
      runId: string
      result: TestRunResult
      outcome: RunOutcome
      reply: string
      checks: CheckResult[]
      transcript: TranscriptEntry[]
      costMicros: number
      model: string
    }

export async function runTestAction(_previous: TestRunState, formData: FormData): Promise<TestRunState> {
  const organizationId = readUuid(formData.get('organizationId'))
  const employeeId = readUuid(formData.get('employeeId'))
  const testCaseId = formData.get('testCaseId') ? readUuid(formData.get('testCaseId')) : undefined
  const input = formData.get('input')
  if (!organizationId || !employeeId || testCaseId === null) return { status: 'error', message: NOT_ALLOWED }
  if (!testCaseId && (typeof input !== 'string' || !input.trim())) return { status: 'error', message: 'Write a request for the employee to handle.' }
  if (typeof input === 'string' && input.length > 4000) return { status: 'error', message: 'Keep the request under 4,000 characters.' }

  const caller = await member(organizationId, 'operator')
  if (!caller.ok) return { status: 'error', message: caller.message }
  if (!isModelConfigured()) {
    return { status: 'error', message: 'No AI model is configured on this deployment, so the employee can’t be tested yet (set ANTHROPIC_API_KEY; see docs/credential-setup.md).' }
  }
  if (!isFeatureConfigured('supabaseAdmin')) return { status: 'error', message: 'Test runs need SUPABASE_SECRET_KEY on this deployment (see docs/credential-setup.md).' }
  if (!testLimiter(caller.user.id)) return { status: 'error', message: 'Too many test runs in a short time. Wait a minute and try again.' }

  let integrations = null
  try {
    integrations = getIntegrationRuntime()
  } catch (error) {
    if (!(error instanceof FeatureUnavailableError)) throw error
  }

  const outcome = await runEmployeeTest(
    {
      organizationId,
      employeeId,
      actor: { kind: 'user', userId: caller.user.id, role: caller.role },
      ...(testCaseId ? { testCaseId } : { input: String(input) }),
    },
    { admin: getAdminClient(), gateway: getModelGateway(), integrations, embedder: getEmbedder() },
  )
  refresh(employeeId)
  if (outcome.status === 'refused') return { status: 'error', message: outcome.message }
  const { status: _finished, ...run } = outcome
  return { status: 'done', ...run }
}

const REVIEW_ERRORS: Record<string, string> = {
  P0002: 'That run doesn’t exist, or your role can’t review it.',
  '55000': 'This run can’t be reviewed: only runs waiting for review can be passed, and passed runs can be failed.',
}

export async function reviewTestRun(organizationId: string, employeeId: string, runId: string, verdict: 'passed' | 'failed', note?: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const employee = readUuid(employeeId)
  const id = readUuid(runId)
  if (!org || !employee || !id || (verdict !== 'passed' && verdict !== 'failed')) return actionError(NOT_ALLOWED)
  const caller = await member(org, 'operator')
  if (!caller.ok) return actionError(caller.message, undefined, caller.code)
  const supabase = await createUserClient()
  const { error } = await supabase.rpc('review_employee_test_run', {
    p_run_id: id,
    p_verdict: verdict,
    ...(note?.trim() ? { p_note: note.trim().slice(0, 1000) } : {}),
  })
  if (error) {
    const message = (error.code && REVIEW_ERRORS[error.code]) ?? null
    if (!message) console.error('[employees] reviewing a test run failed', redact({ code: error.code }))
    return actionError(message ?? 'The review couldn’t be saved. Please try again.')
  }
  refresh(employee)
  return actionSuccess(verdict === 'passed' ? 'Marked as passed.' : 'Marked as failed.')
}

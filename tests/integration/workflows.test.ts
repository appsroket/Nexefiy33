// Workflows against a real PostgreSQL with every migration applied: the real
// server actions (under each user's own row-level security), the server-side
// activation checks, the orchestrator, the task runtime, the integration
// executor and the SQL functions together, with a scripted model and a fake
// HubSpot (no live model or provider call).
//
// Generation and drafts: a described workflow is saved as a draft and can't
//   run until an admin activates it.
// Validation: invalid graphs and unauthorized actions are refused before
//   activation (cycles, inactive employees, an action the connection denies,
//   hand-offs a workspace policy denies or requires approval for), and only
//   admins activate.
// Versioning: activation creates an immutable version; runs pin it; editing
//   the draft afterwards changes neither.
// Controlled execution: sequential steps, a condition, an approval gate, an
//   employee step with outputs, a tool action that waits for its own
//   approval; conditional and parallel branches; delays; failure paths;
//   cancellation; a scheduled start; a run that loses its authority stops;
//   the executor refuses actions the version doesn't contain.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelGateway, ModelTurnRequest, ModelTurnResult } from '@/modules/models/server/gateway'
import { processApprovedExecutions, requestAction } from '@/modules/integrations/server/executor'
import type { IntegrationRuntime } from '@/modules/integrations/server/runtime'
import { processEmployeeTasks, type TaskRuntimeDeps } from '@/modules/tasks/server/runner'
import type { WorkflowDefinition } from '@/modules/workflows/domain/types'
import { startDueSchedules } from '@/modules/workflows/server/dispatch'
import { processWorkflowRuns } from '@/modules/workflows/server/orchestrator'

import { jsonResponse } from '../helpers/integration-fixtures'
import type { PgSupabase } from '../helpers/pg-supabase'
import { createTestDatabase, EMPLOYEE, HUBSPOT, LOCAL_DB, OPERATOR, ORG, OWNER, SEARCH_URL, seedSalesEmployee, UPSERT_URL, type TestDatabase } from './database'

const ADMIN = 'a0000000-0000-4000-8000-000000000002'

let db: TestDatabase
let currentUser = OPERATOR
let runtime: IntegrationRuntime | null = null

vi.mock('@/lib/supabase/server', () => ({ createUserClient: async () => db.as(currentUser) }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => db.admin }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url })
  },
}))
vi.mock('@/modules/identity/server/session', () => ({
  SESSION_ENDED_MESSAGE: 'Your session ended.',
  getVerifiedUser: async () => ({ id: currentUser, email: null }),
}))
vi.mock('@/lib/env/server', async (importOriginal) => ({ ...(await importOriginal<object>()), isFeatureConfigured: () => true }))
vi.mock('@/modules/integrations/server/runtime', () => ({ canRunIntegrations: () => runtime !== null, getIntegrationRuntime: () => runtime }))
vi.mock('@/modules/models/server/provider', () => ({ isModelConfigured: () => false, getModelGateway: () => null }))
vi.mock('@/modules/workflows/server/scheduling', () => ({ scheduleWorkflowProcessing: vi.fn() }))

const actions = await import('@/modules/workflows/server/actions')

function scriptedModel(steps: Partial<ModelTurnResult>[]): ModelGateway {
  return {
    provider: 'anthropic',
    turn: vi.fn(async (_request: ModelTurnRequest) => {
      const step = steps.shift()
      if (!step) throw new Error('no more scripted steps')
      return { text: '', toolCalls: [], stopReason: 'end_turn' as const, model: 'claude-sonnet-5-5', usage: { inputTokens: 1000, outputTokens: 100 }, assistantContent: [], ...step }
    }),
    structured: vi.fn(),
  }
}

const finishWith = (outputs: Record<string, string>, summary = 'The lead looks like a real business contact.') => ({
  toolCalls: [{ id: 'call-finish', name: 'finish_task', input: { status: 'completed', summary, receipts: [], outputs } }],
  stopReason: 'tool_use' as const,
})

const manual = { id: 'trigger', type: 'trigger' as const, label: 'Start', config: { kind: 'manual' as const, cron: '', timezone: '' } }
const end = (id: string, summary: string, status: 'succeeded' | 'failed' = 'succeeded') => ({ id, type: 'end' as const, label: id, config: { status, summary } })
const transform = (id: string, key: string, value: string) => ({ id, type: 'transform' as const, label: id, config: { fields: [{ key, value, format: 'text' as const }] } })
const settings = { maxRunMinutes: 120, maxCostUsd: 5 }

function leadFlow(): WorkflowDefinition {
  return {
    inputs: [{ key: 'email', label: 'Email', type: 'email', required: true, description: '' }],
    nodes: [
      manual,
      {
        id: 'review',
        type: 'employee_task',
        label: 'Review the lead',
        config: {
          employeeId: EMPLOYEE,
          instructions: 'Check whether {{inputs.email}} is a real business contact. Do not change anything.',
          outputs: [
            { key: 'qualified', description: 'yes or no' },
            { key: 'first_name', description: 'Their first name' },
          ],
          timeoutMinutes: 60,
          requireVerified: true,
          retry: { maxAttempts: 2, backoffSeconds: 30 },
        },
      },
      { id: 'check', type: 'condition', label: 'Qualified?', config: { match: 'all', rules: [{ left: '{{steps.review.output.qualified}}', operator: 'equals', right: 'yes' }] } },
      { id: 'approve', type: 'approval', label: 'Approve adding', config: { message: 'Add {{inputs.email}} to HubSpot? {{steps.review.output.summary}}', approverRole: 'admin', expiresInHours: 24 } },
      {
        id: 'add',
        type: 'tool_action',
        label: 'Add to HubSpot',
        config: {
          toolKey: 'hubspot.contacts.upsert',
          integrationId: HUBSPOT,
          input: [
            { field: 'email', value: '{{inputs.email}}' },
            { field: 'firstName', value: '{{steps.review.output.first_name}}' },
          ],
          requireApproval: false,
          retry: { maxAttempts: 1, backoffSeconds: 30 },
        },
      },
      end('added', 'Added {{inputs.email}} ({{steps.add.output.result}}).'),
      end('not_added', 'Not qualified: {{inputs.email}}.'),
      end('failed', 'Adding {{inputs.email}} failed.', 'failed'),
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'review' },
      { id: 'e2', source: 'review', target: 'check' },
      { id: 'e3', source: 'check', target: 'approve', branch: 'true' },
      { id: 'e4', source: 'check', target: 'not_added', branch: 'false' },
      { id: 'e5', source: 'approve', target: 'add', branch: 'approved' },
      { id: 'e6', source: 'approve', target: 'not_added', branch: 'rejected' },
      { id: 'e7', source: 'add', target: 'added' },
      { id: 'e8', source: 'add', target: 'failed', branch: 'failure' },
    ],
    settings,
  }
}

beforeEach(async () => {
  if (!LOCAL_DB) return
  db = await createTestDatabase()
  currentUser = OPERATOR
  runtime = null
  if (!process.env.WF_DEBUG) vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (LOCAL_DB) await db.close()
})

async function seed() {
  const seeded = await seedSalesEmployee(db, [
    [SEARCH_URL, () => jsonResponse(200, { total: 0, results: [] })],
    [UPSERT_URL, () => jsonResponse(201, { id: '901', properties: { email: 'new@example.com' } })],
  ])
  runtime = seeded.runtime
  return seeded
}

async function createDraft(name: string, definition: WorkflowDefinition) {
  currentUser = OPERATOR
  const form = new FormData()
  form.set('organizationId', ORG)
  form.set('mode', 'blank')
  form.set('name', name)
  const redirected = (await actions.createWorkflowAction({ status: 'idle' }, form).catch((error: { url?: string }) => error)) as { url?: string }
  const id = redirected.url!.split('/').pop()!
  const saved = await actions.saveWorkflowDraftAction({ organizationId: ORG, workflowId: id, lockVersion: 0, name, description: '', definition, layout: {} })
  if (saved.status !== 'saved') throw new Error(saved.message)
  return { id, lockVersion: saved.lockVersion, report: saved.report }
}

async function activate(id: string, lockVersion: number, name: string, as = OWNER) {
  currentUser = as
  return await actions.activateWorkflowAction({ organizationId: ORG, workflowId: id, lockVersion, confirmName: name })
}

async function startRun(workflowId: string, input: Record<string, unknown> = {}, as: PgSupabase = db.as(OPERATOR)) {
  const { data, error } = await as.rpc('start_workflow_run', { p_workflow_id: workflowId, p_input: input, p_idempotency_key: `run-${Math.random().toString(36).slice(2, 12)}` })
  expect(error).toBeNull()
  return data as string
}

const advance = (now?: () => Date) => processWorkflowRuns({ admin: db.admin as never, integrations: runtime, ...(now ? { now } : {}) }, 5)
const steps = async (runId: string) =>
  Object.fromEntries((await db.sql<{ node_id: string; status: string; branch: string | null }>('select node_id, status, branch from public.workflow_run_steps where run_id = $1', [runId])).map((row) => [row.node_id, row.branch ? `${row.status}:${row.branch}` : row.status]))
const runRow = async (runId: string) => (await db.sql<Record<string, unknown>>('select * from public.workflow_runs where id = $1', [runId]))[0]!

describe.skipIf(!LOCAL_DB)('workflows on PostgreSQL', () => {
  it('generates a draft from a description that can’t run until an admin activates it', async () => {
    await seed()
    const form = new FormData()
    form.set('organizationId', ORG)
    form.set('mode', 'describe')
    form.set('description', 'When a new lead comes in, check it and, if it looks qualified, add the contact to HubSpot after a manager approves.')
    const redirected = (await actions.createWorkflowAction({ status: 'idle' }, form).catch((error: { url?: string }) => error)) as { url?: string }
    const id = redirected.url!.split('/').pop()!
    const [row] = await db.sql<{ status: string; draft_source: string; current_version_id: string | null; draft_graph: WorkflowDefinition; draft_generation: { generator: string; notes: string[] } }>(
      'select status, draft_source, current_version_id, draft_graph, draft_generation from public.workflow_definitions where id = $1',
      [id],
    )
    expect(row).toMatchObject({ status: 'draft', draft_source: 'rules', current_version_id: null, draft_generation: { generator: 'rules' } })
    expect(row!.draft_generation.notes[0]).toContain('keyword rules')
    const types = row!.draft_graph.nodes.map((node) => node.type)
    expect(types).toEqual(expect.arrayContaining(['trigger', 'employee_task', 'approval', 'tool_action', 'end']))
    // The approval comes before the change.
    const approve = row!.draft_graph.edges.find((edge) => edge.branch === 'approved')
    expect(row!.draft_graph.nodes.find((node) => node.id === approve?.target)?.type).toBe('tool_action')

    const { error } = await db.as(OPERATOR).rpc('start_workflow_run', { p_workflow_id: id, p_input: {}, p_idempotency_key: 'run-draft-0001' })
    expect(error?.code).toBe('55000')
  })

  it('refuses invalid graphs and unauthorized actions before activation; only admins activate', async () => {
    await seed()
    const flow = leadFlow()
    const looped = { ...flow, edges: [...flow.edges, { id: 'e9', source: 'check', target: 'review', branch: 'true' as const }] }
    const draft = await createDraft('Looped', looped)
    expect(draft.report.valid).toBe(false)
    let result = await activate(draft.id, draft.lockVersion, 'Looped')
    expect(result).toMatchObject({ status: 'invalid', report: { errors: expect.arrayContaining([expect.objectContaining({ code: 'cycle' })]) } })

    const good = await createDraft('Leads', leadFlow())
    expect(await activate(good.id, good.lockVersion, 'Leads', OPERATOR)).toMatchObject({ status: 'error', message: expect.stringContaining('Only admins') })
    expect(await activate(good.id, good.lockVersion, 'Lead')).toMatchObject({ status: 'error', message: expect.stringContaining('Type the workflow’s name') })

    // The connection turned the action off: activation is refused.
    await db.sql(`insert into public.integration_actions (organization_id, integration_id, action_key, risk_level, enabled) values ($1, $2, 'hubspot.contacts.upsert', 'write_external', false)`, [ORG, HUBSPOT])
    result = await activate(good.id, good.lockVersion, 'Leads')
    expect(result).toMatchObject({ status: 'invalid', report: { errors: [expect.objectContaining({ code: 'action_denied', nodeId: 'add' })] } })
    await db.sql(`delete from public.integration_actions where integration_id = $1`, [HUBSPOT])

    // An employee that isn't active can't be activated into a workflow.
    await db.sql(`update public.ai_employees set status = 'paused' where id = $1`, [EMPLOYEE])
    result = await activate(good.id, good.lockVersion, 'Leads')
    expect(result).toMatchObject({ status: 'invalid', report: { errors: [expect.objectContaining({ code: 'employee_not_active' })] } })
    await db.sql(`update public.ai_employees set status = 'active' where id = $1`, [EMPLOYEE])

    // A stale editor can't activate over a newer save.
    expect(await activate(good.id, good.lockVersion - 1, 'Leads')).toMatchObject({ status: 'error', code: 'conflict' })
    result = await activate(good.id, good.lockVersion, 'Leads')
    expect(result).toMatchObject({ status: 'activated', version: 1 })
  })

  it('hands work between employees only as the workflow and workspace policy allow', async () => {
    const seeded = await seed()
    const second = 'a2000000-0000-4000-8000-0000000000e2'
    await db.sql(`insert into public.ai_employees (id, organization_id, name, role_category) values ($1, $2, 'Report Writer', 'marketing')`, [second, ORG])
    const [version] = await db.sql<{ id: string }>(
      `insert into public.employee_versions (organization_id, employee_id, instructions, config, config_schema_version) values ($1, $2, 'Write.', $3, 2) returning id`,
      [ORG, second, JSON.stringify({ ...seeded.config, profile: { ...seeded.config.profile, name: 'Report Writer' }, tools: [] })],
    )
    await db.sql(`update public.ai_employees set current_version_id = $1, active_version_id = $1, status = 'active', activated_at = now() where id = $2`, [version!.id, second])
    const employeeStep = (id: string, employeeId: string, instructions: string) => ({
      id,
      type: 'employee_task' as const,
      label: id,
      config: { employeeId, instructions, outputs: [], timeoutMinutes: 60, requireVerified: true, retry: { maxAttempts: 1, backoffSeconds: 30 } },
    })
    const handoff: WorkflowDefinition = {
      inputs: [],
      nodes: [manual, employeeStep('research', EMPLOYEE, 'Research.'), employeeStep('write', second, 'Write up: {{steps.research.output.summary}}'), end('done', 'Done.')],
      edges: [
        { id: 'e1', source: 'trigger', target: 'research' },
        { id: 'e2', source: 'research', target: 'write' },
        { id: 'e3', source: 'write', target: 'done' },
      ],
      settings,
    }
    const draft = await createDraft('Hand-off', handoff)
    await db.sql(`insert into public.organization_policies (organization_id, name, policy) values ($1, 'No hand-offs', '{"rules": [{"effect": "deny", "toolKeys": ["workflow.handoff"]}]}')`, [ORG])
    expect(await activate(draft.id, draft.lockVersion, 'Hand-off')).toMatchObject({ status: 'invalid', report: { errors: [expect.objectContaining({ code: 'handoff_denied', nodeId: 'write' })] } })

    await db.sql(`update public.organization_policies set policy = '{"rules": [{"effect": "require_approval", "toolKeys": ["workflow.handoff"]}]}' where name = 'No hand-offs'`)
    expect(await activate(draft.id, draft.lockVersion, 'Hand-off')).toMatchObject({ status: 'invalid', report: { errors: [expect.objectContaining({ code: 'handoff_needs_approval' })] } })

    const withApproval: WorkflowDefinition = {
      ...handoff,
      nodes: [...handoff.nodes, { id: 'review', type: 'approval', label: 'Review the research', config: { message: '{{steps.research.output.summary}}', approverRole: 'operator', expiresInHours: 24 } }],
      edges: [
        { id: 'e1', source: 'trigger', target: 'research' },
        { id: 'e2', source: 'research', target: 'review' },
        { id: 'e4', source: 'review', target: 'write', branch: 'approved' },
        { id: 'e3', source: 'write', target: 'done' },
      ],
    }
    currentUser = OPERATOR
    const saved = await actions.saveWorkflowDraftAction({ organizationId: ORG, workflowId: draft.id, lockVersion: draft.lockVersion, name: 'Hand-off', description: '', definition: withApproval, layout: {} })
    expect(saved).toMatchObject({ status: 'saved' })
    const activated = await activate(draft.id, (saved as { lockVersion: number }).lockVersion, 'Hand-off')
    expect(activated).toMatchObject({ status: 'activated' })
    const [stored] = await db.sql<{ validation_report: { handoffs: { decision: string }[] } }>('select validation_report from public.workflow_versions where workflow_id = $1', [draft.id])
    expect(stored!.validation_report.handoffs).toEqual([{ from: 'research', to: 'write', decision: 'require_approval' }])
  })

  it('runs an activated version end to end: employee step, condition, approval gate, an action with its own approval', async () => {
    const seeded = await seed()
    const draft = await createDraft('Leads', leadFlow())
    const activated = await activate(draft.id, draft.lockVersion, 'Leads')
    expect(activated).toMatchObject({ status: 'activated', version: 1 })
    const [version] = await db.sql<{ id: string; graph: WorkflowDefinition }>('select id, graph from public.workflow_versions where workflow_id = $1', [draft.id])
    // The version records which employee version the step runs.
    expect(version!.graph.nodes.find((node) => node.id === 'review')).toMatchObject({ config: { employeeVersionId: seeded.versionId } })

    const runId = await startRun(draft.id, { email: 'new@example.com' })
    expect((await runRow(runId)).workflow_version_id).toBe(version!.id)

    // Editing the draft afterwards doesn't touch the version or the run.
    currentUser = OPERATOR
    const edited = { ...leadFlow(), settings: { maxRunMinutes: 30, maxCostUsd: 1 } }
    const [current] = await db.sql<{ lock_version: number }>('select lock_version from public.workflow_definitions where id = $1', [draft.id])
    expect(await actions.saveWorkflowDraftAction({ organizationId: ORG, workflowId: draft.id, lockVersion: current!.lock_version, name: 'Leads', description: '', definition: edited, layout: {} })).toMatchObject({ status: 'saved' })
    const [unchanged] = await db.sql<{ graph: WorkflowDefinition }>('select graph from public.workflow_versions where id = $1', [version!.id])
    expect(unchanged!.graph.settings.maxRunMinutes).toBe(120)

    // 1. The trigger runs and the employee step becomes a task for the pinned version.
    expect((await advance()).results[0]).toMatchObject({ runId, status: 'running', queuedTasks: 1 })
    expect(await steps(runId)).toEqual({ trigger: 'succeeded', review: 'running' })
    const [task] = await db.sql<{ id: string; employee_version_id: string; instructions: string; source: string }>(
      'select id, employee_version_id, instructions, source from public.tasks where workflow_run_id = $1 and node_id = $2',
      [runId, 'review'],
    )
    expect(task).toMatchObject({ employee_version_id: seeded.versionId, source: 'workflow' })
    expect(task!.instructions).toContain('Check whether new@example.com is a real business contact')

    // 2. The employee works on it (the task runtime), reporting the outputs the step asked for.
    const model = scriptedModel([finishWith({ qualified: 'yes', first_name: 'New' })])
    const deps: TaskRuntimeDeps = { admin: db.admin as never, gateway: model, integrations: seeded.runtime, embedder: null, sleep: async () => {} }
    expect((await processEmployeeTasks(deps, 1, task!.id)).results[0]).toMatchObject({ status: 'succeeded' })
    const tools = (model.turn as ReturnType<typeof vi.fn>).mock.calls[0]![0].tools as { name: string; inputSchema: { required: string[] } }[]
    expect(tools.find((tool) => tool.name === 'finish_task')!.inputSchema.required).toContain('outputs')

    // 3. The condition is true; the gate waits for an admin.
    expect((await advance()).results[0]).toMatchObject({ status: 'waiting' })
    expect(await steps(runId)).toMatchObject({ review: 'succeeded', check: 'succeeded:true', approve: 'waiting' })
    const [gate] = await db.sql<{ id: string; payload_sha256: string; proposed_action: { message: string }; required_role: string }>(
      `select id, payload_sha256, proposed_action, required_role from public.approval_requests where workflow_run_id = $1 and kind = 'workflow_gate'`,
      [runId],
    )
    expect(gate!.proposed_action.message).toBe('Add new@example.com to HubSpot? The lead looks like a real business contact.')
    expect((await db.as(OPERATOR).rpc('decide_approval', { p_request_id: gate!.id, p_decision: 'approved', p_payload_sha256: gate!.payload_sha256 })).error?.code).toBe('P0002')
    expect((await db.as(OWNER).rpc('decide_approval', { p_request_id: gate!.id, p_decision: 'approved', p_payload_sha256: gate!.payload_sha256 })).error).toBeNull()

    // 4. The action is requested by the workflow and waits for approval of its exact payload.
    expect((await advance()).results[0]).toMatchObject({ status: 'waiting' })
    expect(await steps(runId)).toMatchObject({ approve: 'succeeded:approved', add: 'waiting' })
    const [actionApproval] = await db.sql<{ id: string; payload_sha256: string; proposed_action: { input: Record<string, string> } }>(
      `select id, payload_sha256, proposed_action from public.approval_requests where workflow_run_id = $1 and kind = 'tool_action'`,
      [runId],
    )
    expect(actionApproval!.proposed_action.input).toEqual({ email: 'new@example.com', firstName: 'New' })
    expect(seeded.requests.filter((request) => request.method === 'POST' && request.url === UPSERT_URL)).toHaveLength(0)
    await db.as(OWNER).rpc('decide_approval', { p_request_id: actionApproval!.id, p_decision: 'approved', p_payload_sha256: actionApproval!.payload_sha256 })
    await processApprovedExecutions(seeded.runtime, 5)

    // 5. The action ran once; the run finishes on its success path.
    expect((await advance()).results[0]).toMatchObject({ status: 'succeeded' })
    expect(await steps(runId)).toMatchObject({ add: 'succeeded', added: 'succeeded', not_added: 'skipped', failed: 'skipped' })
    expect(await runRow(runId)).toMatchObject({ status: 'succeeded', summary: 'Added new@example.com (created).', lease_token: null })
    const events = (await db.sql<{ event_type: string }>('select event_type from public.execution_events where workflow_run_id = $1 order by id', [runId])).map((row) => row.event_type)
    expect(events).toEqual(expect.arrayContaining(['run.queued', 'run.started', 'step.started', 'step.condition', 'step.waiting_approval', 'step.approved', 'run.succeeded']))
    // Nothing more to do.
    expect((await advance()).claimed).toBe(0)
  })

  it('takes one path at a condition, runs parallel branches and joins them', async () => {
    await seed()
    const flow: WorkflowDefinition = {
      inputs: [{ key: 'count', label: 'Count', type: 'number', required: true, description: '' }],
      nodes: [
        manual,
        { id: 'big', type: 'condition', label: 'Big?', config: { match: 'all', rules: [{ left: '{{inputs.count}}', operator: 'greater_than', right: '5' }] } },
        transform('yes', 'size', 'big'),
        transform('no', 'size', 'small'),
        transform('left', 'part', 'L'),
        transform('right', 'part', 'R'),
        end('done', 'count={{inputs.count}} left={{steps.left.output.part}} right={{steps.right.output.part}}'),
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'big' },
        { id: 'e2', source: 'big', target: 'yes', branch: 'true' },
        { id: 'e3', source: 'big', target: 'no', branch: 'false' },
        { id: 'e4', source: 'yes', target: 'left' },
        { id: 'e5', source: 'yes', target: 'right' },
        { id: 'e6', source: 'no', target: 'done' },
        { id: 'e7', source: 'left', target: 'done' },
        { id: 'e8', source: 'right', target: 'done' },
      ],
      settings,
    }
    const draft = await createDraft('Branches', flow)
    expect(draft.report.errors).toEqual([expect.objectContaining({ code: 'reference_not_upstream' }), expect.objectContaining({ code: 'reference_not_upstream' })])
    // Referencing a branch that might not run is refused; use only what always runs.
    currentUser = OPERATOR
    const fixed = { ...flow, nodes: flow.nodes.map((node) => (node.id === 'done' ? end('done', 'count={{inputs.count}}') : node)) }
    const saved = await actions.saveWorkflowDraftAction({ organizationId: ORG, workflowId: draft.id, lockVersion: draft.lockVersion, name: 'Branches', description: '', definition: fixed, layout: {} })
    expect(saved).toMatchObject({ status: 'saved', report: { valid: true } })
    expect(await activate(draft.id, (saved as { lockVersion: number }).lockVersion, 'Branches')).toMatchObject({ status: 'activated' })

    const big = await startRun(draft.id, { count: 9 })
    const small = await startRun(draft.id, { count: 2 })
    await advance()
    expect(await steps(big)).toEqual({ trigger: 'succeeded', big: 'succeeded:true', yes: 'succeeded', no: 'skipped', left: 'succeeded', right: 'succeeded', done: 'succeeded' })
    expect(await steps(small)).toEqual({ trigger: 'succeeded', big: 'succeeded:false', yes: 'skipped', no: 'succeeded', left: 'skipped', right: 'skipped', done: 'succeeded' })
    expect(await runRow(big)).toMatchObject({ status: 'succeeded', summary: 'count=9' })
  })

  it('waits on a delay as a step state, and fails along a failure path', async () => {
    await seed()
    const flow: WorkflowDefinition = {
      inputs: [],
      nodes: [
        manual,
        { id: 'wait', type: 'delay', label: 'Wait', config: { minutes: 30 } },
        {
          id: 'add',
          type: 'tool_action',
          label: 'Add',
          config: { toolKey: 'hubspot.contacts.upsert', integrationId: HUBSPOT, input: [{ field: 'email', value: 'not-an-email' }], requireApproval: false, retry: { maxAttempts: 1, backoffSeconds: 0 } },
        },
        end('done', 'Done.'),
        end('broken', 'The action failed: {{run.id}}', 'failed'),
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'wait' },
        { id: 'e2', source: 'wait', target: 'add' },
        { id: 'e3', source: 'add', target: 'done' },
        { id: 'e4', source: 'add', target: 'broken', branch: 'failure' },
      ],
      settings,
    }
    const draft = await createDraft('Delayed', flow)
    expect(await activate(draft.id, draft.lockVersion, 'Delayed')).toMatchObject({ status: 'activated' })
    const runId = await startRun(draft.id)
    expect((await advance()).results[0]).toMatchObject({ status: 'waiting' })
    const waiting = await runRow(runId)
    expect(waiting.wake_at).not.toBeNull()
    expect((await advance()).claimed).toBe(0)

    const later = () => new Date(Date.now() + 31 * 60_000)
    await db.sql(`update public.workflow_runs set wake_at = now() - interval '1 second' where id = $1`, [runId])
    expect((await advance(later)).results[0]).toMatchObject({ status: 'failed' })
    expect(await steps(runId)).toMatchObject({ wait: 'succeeded', add: 'failed:failure', broken: 'succeeded', done: 'skipped' })
    const [step] = await db.sql<{ error: { code: string } }>(`select error from public.workflow_run_steps where run_id = $1 and node_id = 'add'`, [runId])
    expect(step!.error.code).toBe('invalid_input')
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error: expect.objectContaining({ code: 'ended_failed' }) })
  })

  it('cancelling stops future work and withdraws the waiting approval; an approval rejection follows the rejected path', async () => {
    const seeded = await seed()
    const draft = await createDraft('Leads', leadFlow())
    await activate(draft.id, draft.lockVersion, 'Leads')
    const deps: TaskRuntimeDeps = { admin: db.admin as never, gateway: scriptedModel([finishWith({ qualified: 'yes', first_name: 'A' }), finishWith({ qualified: 'yes', first_name: 'B' })]), integrations: seeded.runtime, embedder: null, sleep: async () => {} }

    const cancelled = await startRun(draft.id, { email: 'a@example.com' })
    const rejected = await startRun(draft.id, { email: 'b@example.com' })
    await advance()
    await processEmployeeTasks(deps, 2)
    await advance()
    expect(await steps(cancelled)).toMatchObject({ approve: 'waiting' })

    currentUser = OPERATOR
    expect(await actions.cancelRunAction(cancelled)).toMatchObject({ status: 'success', message: expect.stringContaining('Cancelled') })
    expect(await runRow(cancelled)).toMatchObject({ status: 'cancelled' })
    expect(await steps(cancelled)).toMatchObject({ approve: 'cancelled' })
    const [gate] = await db.sql<{ status: string }>(`select status from public.approval_requests where workflow_run_id = $1`, [cancelled])
    expect(gate!.status).toBe('cancelled')

    const [other] = await db.sql<{ id: string; payload_sha256: string }>(`select id, payload_sha256 from public.approval_requests where workflow_run_id = $1`, [rejected])
    await db.as(OWNER).rpc('decide_approval', { p_request_id: other!.id, p_decision: 'rejected', p_payload_sha256: other!.payload_sha256 })
    await advance()
    expect(await steps(rejected)).toMatchObject({ approve: 'succeeded:rejected', add: 'skipped', not_added: 'succeeded' })
    expect(await runRow(rejected)).toMatchObject({ status: 'succeeded', summary: 'Not qualified: b@example.com.' })
    expect(seeded.requests.filter((request) => request.method === 'POST' && request.url === UPSERT_URL)).toHaveLength(0)
  })

  it('a run stops when its activator is no longer an admin, and the executor refuses actions the version doesn’t contain', async () => {
    await seed()
    const flow: WorkflowDefinition = {
      inputs: [],
      nodes: [manual, { id: 'gate', type: 'approval', label: 'Gate', config: { message: 'Go?', approverRole: 'operator', expiresInHours: 1 } }, end('done', 'Done.')],
      edges: [
        { id: 'e1', source: 'trigger', target: 'gate' },
        { id: 'e2', source: 'gate', target: 'done', branch: 'approved' },
      ],
      settings,
    }
    const draft = await createDraft('Guarded', flow)
    expect(await activate(draft.id, draft.lockVersion, 'Guarded', ADMIN)).toMatchObject({ status: 'activated' })
    const runId = await startRun(draft.id)
    await advance()
    const [task] = await db.sql<{ id: string }>(`select id from public.tasks where workflow_run_id = $1 and node_id = 'gate'`, [runId])
    const [version] = await db.sql<{ id: string }>('select id from public.workflow_versions where workflow_id = $1', [draft.id])

    // The version has no tool action: the executor refuses one, whatever the caller says.
    const refused = await requestAction(runtime!, {
      organizationId: ORG,
      integrationId: HUBSPOT,
      actionKey: 'hubspot.contacts.upsert',
      input: { email: 'x@example.com' },
      idempotencyKey: `workflow:${runId}:gate:1`,
      actor: { kind: 'workflow', runId, nodeId: 'gate', taskId: task!.id, workflowVersionId: version!.id, authorizedBy: ADMIN, requestedBy: OPERATOR },
    })
    expect(refused).toMatchObject({ status: 'refused', error: { code: 'forbidden' } })

    await db.sql(`update public.organization_members set role = 'operator' where user_id = $1 and organization_id = $2`, [ADMIN, ORG])
    await db.sql(`update public.workflow_runs set advance_requested_at = now() where id = $1`, [runId])
    expect((await advance()).results[0]).toMatchObject({ status: 'failed' })
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error: expect.objectContaining({ code: 'authorization_lost' }) })
    const [gate] = await db.sql<{ status: string }>(`select status from public.approval_requests where workflow_run_id = $1`, [runId])
    expect(gate!.status).toBe('cancelled')
  })

  it('starts a scheduled run of the activated version when its time comes', async () => {
    await seed()
    const flow: WorkflowDefinition = {
      inputs: [],
      nodes: [{ id: 'trigger', type: 'trigger', label: 'Hourly', config: { kind: 'schedule', cron: '0 * * * *', timezone: 'Europe/Paris' } }, end('done', 'Ran at {{run.startedAt}}.')],
      edges: [{ id: 'e1', source: 'trigger', target: 'done' }],
      settings,
    }
    const draft = await createDraft('Hourly', flow)
    expect(await activate(draft.id, draft.lockVersion, 'Hourly')).toMatchObject({ status: 'activated' })
    const [trigger] = await db.sql<{ id: string; next_run_at: Date; enabled: boolean }>('select id, next_run_at, enabled from public.workflow_triggers where workflow_id = $1', [draft.id])
    expect(trigger).toMatchObject({ enabled: true })
    expect(new Date(trigger!.next_run_at).getUTCMinutes()).toBe(0)

    expect(await startDueSchedules(db.admin as never, new Date())).toBe(0)
    await db.sql(`update public.workflow_triggers set next_run_at = now() - interval '1 minute' where id = $1`, [trigger!.id])
    expect(await startDueSchedules(db.admin as never, new Date())).toBe(1)
    const [run] = await db.sql<{ id: string; trigger_type: string }>('select id, trigger_type from public.workflow_runs where workflow_id = $1', [draft.id])
    expect(run).toMatchObject({ trigger_type: 'schedule' })
    expect(await startDueSchedules(db.admin as never, new Date())).toBe(0)
    await advance()
    expect(await runRow(run!.id)).toMatchObject({ status: 'succeeded' })
  })
})

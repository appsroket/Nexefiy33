// Test runs: an employee's latest saved version answers a request (a saved
// test case or a free-form prompt) through the shared runtime with the test
// invoker. The run, its transcript, automatic checks, tokens and cost are
// recorded (employee_test_runs, written here with the service role after the
// caller's role was checked), and its cost counts toward the employee's
// monthly budget (usage_records).
//
// Every query is scoped to the organization the caller is a verified member of.

import 'server-only'

import type { AdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/lib/supabase/types'
import type { UserActor } from '@/modules/integrations/server/executor'
import type { IntegrationRuntime } from '@/modules/integrations/server/runtime'
import { formatBusinessContextForModel } from '@/modules/knowledge/domain/business-context'
import type { Embedder } from '@/modules/knowledge/server/embeddings'
import { getBusinessContext } from '@/modules/knowledge/server/queries'
import type { ModelGateway } from '@/modules/models/server/gateway'

import { employeeConfigSchema, testExpectationsSchema } from '../domain/schemas'
import { evaluateChecks, runResult, type CheckResult } from '../domain/test-checks'
import type { RunOutcome, TestExpectations, TestRunResult } from '../domain/types'
import { runEmployee, type TranscriptEntry } from './runtime'
import { createTestToolInvoker } from './test-invoker'

/** Runs still "running" after this long were interrupted (the server stopped). */
const STALE_RUN_MINUTES = 15

export interface PlaygroundDeps {
  admin: AdminClient
  gateway: ModelGateway
  integrations: IntegrationRuntime | null
  embedder: Embedder | null
  now?: () => Date
}

export interface TestRunRequest {
  organizationId: string
  employeeId: string
  actor: UserActor
  testCaseId?: string
  input?: string
}

export type TestRunOutcome =
  | { status: 'refused'; message: string }
  | {
      status: 'finished'
      runId: string
      result: TestRunResult
      outcome: RunOutcome
      reply: string
      checks: CheckResult[]
      transcript: TranscriptEntry[]
      costMicros: number
      model: string
    }

export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/** Model spend recorded for an employee since the start of the month (UTC), in micro-dollars. */
export async function monthlySpendMicros(admin: AdminClient, organizationId: string, employeeId: string, now: Date): Promise<number> {
  const { data, error } = await admin
    .from('usage_records')
    .select('cost_micros')
    .eq('organization_id', organizationId)
    .eq('employee_id', employeeId)
    .eq('metric', 'model_cost')
    .gte('occurred_at', monthStart(now))
  if (error) throw new Error('The employee’s spending couldn’t be loaded.')
  return (data ?? []).reduce((sum, row) => sum + (row.cost_micros ?? 0), 0)
}

export async function runEmployeeTest(request: TestRunRequest, deps: PlaygroundDeps): Promise<TestRunOutcome> {
  const { admin, organizationId, employeeId } = { admin: deps.admin, ...request }
  const now = deps.now ?? (() => new Date())

  const { data: employee, error: employeeError } = await admin
    .from('ai_employees')
    .select('id, name, lifecycle_status, current_version_id')
    .eq('id', employeeId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (employeeError) throw new Error('The employee couldn’t be loaded.')
  if (!employee || !employee.current_version_id) return { status: 'refused', message: 'That employee doesn’t exist in this workspace.' }
  if (employee.lifecycle_status === 'archived') return { status: 'refused', message: 'Archived employees can’t be tested. Restore it first.' }

  const { data: version, error: versionError } = await admin
    .from('employee_versions')
    .select('id, version, instructions, config, config_schema_version')
    .eq('id', employee.current_version_id)
    .eq('employee_id', employeeId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (versionError || !version) throw new Error('The employee’s configuration couldn’t be loaded.')
  const config = version.config_schema_version === 2 ? employeeConfigSchema.safeParse(version.config) : null
  if (!config?.success) return { status: 'refused', message: 'This version uses an older configuration format. Open the editor and save it again.' }

  let input = request.input?.trim() ?? ''
  let expectations: TestExpectations = {}
  if (request.testCaseId) {
    const { data: testCase, error } = await admin
      .from('employee_test_cases')
      .select('id, input, expectations')
      .eq('id', request.testCaseId)
      .eq('employee_id', employeeId)
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) throw new Error('The test case couldn’t be loaded.')
    if (!testCase) return { status: 'refused', message: 'That test case doesn’t exist.' }
    input = testCase.input
    expectations = testExpectationsSchema.catch({}).parse(testCase.expectations)
  }
  if (!input) return { status: 'refused', message: 'Write a request for the employee to handle.' }

  const spent = await monthlySpendMicros(admin, organizationId, employeeId, now())
  const budgetMicros = Math.round(config.data.budget.monthlyUsd * 1_000_000)
  if (spent >= budgetMicros) return { status: 'refused', message: 'This employee has used its monthly budget. Raise the budget in the editor to keep testing.' }

  // Runs left "running" by a stopped server would otherwise stay that way forever.
  const staleBefore = new Date(now().getTime() - STALE_RUN_MINUTES * 60_000).toISOString()
  await admin
    .from('employee_test_runs')
    .update({ result: 'error', outcome: 'error', finished_at: now().toISOString(), error: { code: 'interrupted', message: 'The run was interrupted.' } })
    .eq('organization_id', organizationId)
    .eq('employee_id', employeeId)
    .eq('result', 'running')
    .lt('started_at', staleBefore)

  const { data: run, error: runError } = await admin
    .from('employee_test_runs')
    .insert({
      organization_id: organizationId,
      employee_id: employeeId,
      version_id: version.id,
      test_case_id: request.testCaseId ?? null,
      input,
      created_by: request.actor.userId,
      started_at: now().toISOString(),
    })
    .select('id')
    .single()
  if (runError || !run) {
    if (runError?.code === '23514') return { status: 'refused', message: 'The request contains something that looks like a password, token or API key.' }
    throw new Error('The test run couldn’t be recorded.')
  }

  const { data: organization } = await admin.from('organizations').select('name').eq('id', organizationId).maybeSingle()
  const organizationName = organization?.name ?? null
  let businessContext: string | null = null
  try {
    businessContext = formatBusinessContextForModel(await getBusinessContext(admin, organizationId, organizationName ?? ''), now())
  } catch {
    businessContext = null
  }

  const invoker = createTestToolInvoker({
    organizationId,
    employeeId,
    runId: run.id,
    actor: request.actor,
    knowledge: config.data.knowledge,
    admin,
    embedder: deps.embedder,
    integrations: deps.integrations,
  })

  let result: Awaited<ReturnType<typeof runEmployee>>
  try {
    result = await runEmployee(
      {
        employeeName: employee.name,
        organizationName,
        instructions: version.instructions,
        config: config.data,
        input,
        businessContext,
        budgetRemainingMicros: budgetMicros - spent,
      },
      { gateway: deps.gateway, invoker },
    )
  } catch (error) {
    await admin
      .from('employee_test_runs')
      .update({ result: 'error', outcome: 'error', finished_at: now().toISOString(), error: { code: 'internal', message: 'The run failed unexpectedly.' } })
      .eq('id', run.id)
      .eq('organization_id', organizationId)
    throw error
  }

  // Test runs never wait (the test invoker doesn't request actions) and can't be cancelled.
  const outcome: RunOutcome = result.outcome === 'waiting_approval' || result.outcome === 'cancelled' ? 'error' : result.outcome
  const checks = evaluateChecks(expectations, { outcome, reply: result.reply, toolCalls: result.toolCalls })
  const outcomeResult = runResult({ outcome, reply: result.reply, toolCalls: result.toolCalls }, checks, Boolean(request.testCaseId))

  const { error: updateError } = await admin
    .from('employee_test_runs')
    .update({
      result: outcomeResult,
      outcome,
      reply: result.reply.slice(0, 20_000) || null,
      transcript: result.transcript as unknown as Json,
      checks: checks as unknown as Json,
      model: result.model,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cost_micros: result.costMicros,
      finished_at: now().toISOString(),
      error: result.error ? (result.error as unknown as Json) : outcomeResult === 'error' ? { code: 'unknown', message: 'The run ended with an error.' } : null,
    })
    .eq('id', run.id)
    .eq('organization_id', organizationId)
  if (updateError) {
    // A transcript can be refused when a tool result contains something credential-shaped; keep the verdict, drop the details.
    await admin
      .from('employee_test_runs')
      .update({
        result: 'error',
        outcome: 'error',
        finished_at: now().toISOString(),
        error: { code: 'not_recorded', message: 'The run finished but its transcript couldn’t be stored (it may contain something credential-shaped).' },
        cost_micros: result.costMicros,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        model: result.model,
      })
      .eq('id', run.id)
      .eq('organization_id', organizationId)
  }

  if (result.costMicros > 0 || result.usage.inputTokens > 0) {
    const occurredAt = now().toISOString()
    const common = { organization_id: organizationId, employee_id: employeeId, provider: 'anthropic', model: result.model, occurred_at: occurredAt }
    await admin.from('usage_records').upsert(
      [
        { ...common, metric: 'model_cost', quantity: 1, cost_micros: result.costMicros, currency: 'USD', idempotency_key: `employee-test:${run.id}:cost` },
        { ...common, metric: 'model_input_tokens', quantity: result.usage.inputTokens, idempotency_key: `employee-test:${run.id}:input` },
        { ...common, metric: 'model_output_tokens', quantity: result.usage.outputTokens, idempotency_key: `employee-test:${run.id}:output` },
      ],
      { onConflict: 'organization_id,idempotency_key', ignoreDuplicates: true },
    )
  }

  return {
    status: 'finished',
    runId: run.id,
    result: updateError ? 'error' : outcomeResult,
    outcome,
    reply: result.reply,
    checks,
    transcript: result.transcript,
    costMicros: result.costMicros,
    model: result.model,
  }
}

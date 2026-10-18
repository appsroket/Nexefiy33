// Read models for the employee pages, loaded with the user's session so RLS
// limits them to workspaces the user belongs to (and every query also filters
// by the active organization).

import 'server-only'

import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'
import { listConnections } from '@/modules/integrations/server/queries'
import { listKnowledgeSources } from '@/modules/knowledge/server/queries'

import { employeeConfigSchema, testExpectationsSchema } from '../domain/schemas'
import type { CheckResult } from '../domain/test-checks'
import {
  TEST_STATUSES,
  type ConnectionOption,
  type Department,
  type EmployeeConfig,
  type KnowledgeSourceOption,
  type LifecycleState,
  type RunOutcome,
  type SkillOption,
  type TestExpectations,
  type TestRunResult,
  type TestStatus,
} from '../domain/types'
import type { TranscriptEntry } from './runtime'

export class EmployeeDataError extends Error {
  override name = 'EmployeeDataError'
}

function fail(what: string, error: { code?: string }): never {
  console.error(`[employees] loading ${what} failed`, redact({ code: error.code }))
  throw new EmployeeDataError(`We couldn’t load ${what}. Please try again.`)
}

function asTestStatus(value: string | null | undefined): TestStatus {
  return (TEST_STATUSES as readonly string[]).includes(value ?? '') ? (value as TestStatus) : 'untested'
}

export interface EmployeeListItem {
  id: string
  name: string
  department: Department
  description: string | null
  state: LifecycleState
  currentVersion: number | null
  activeVersion: number | null
  testStatus: TestStatus
  updatedAt: string
}

export async function listEmployees(organizationId: string): Promise<EmployeeListItem[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('ai_employees')
    .select('id, name, role_category, description, lifecycle_status, current_version_id, active_version_id, updated_at')
    .eq('organization_id', organizationId)
    .order('updated_at', { ascending: false })
    .limit(200)
  if (error) fail('employees', error)

  const versionIds = data.flatMap((row) => [row.current_version_id, row.active_version_id]).filter((id): id is string => Boolean(id))
  const numbers = new Map<string, number>()
  if (versionIds.length) {
    const { data: versions, error: versionError } = await supabase
      .from('employee_versions')
      .select('id, version')
      .eq('organization_id', organizationId)
      .in('id', [...new Set(versionIds)])
    if (versionError) fail('employee versions', versionError)
    for (const version of versions) numbers.set(version.id, version.version)
  }

  const statuses = await Promise.all(
    data.map(async (row) => {
      if (!row.current_version_id) return 'untested' as TestStatus
      const { data: summary } = await supabase.rpc('employee_test_summary', { p_employee_id: row.id })
      return asTestStatus(summary?.find((entry) => entry.version_id === row.current_version_id)?.test_status)
    }),
  )

  return data.map((row, index) => ({
    id: row.id,
    name: row.name,
    department: row.role_category as Department,
    description: row.description,
    state: row.lifecycle_status as LifecycleState,
    currentVersion: row.current_version_id ? (numbers.get(row.current_version_id) ?? null) : null,
    activeVersion: row.active_version_id ? (numbers.get(row.active_version_id) ?? null) : null,
    testStatus: statuses[index]!,
    updatedAt: row.updated_at,
  }))
}

export interface VersionView {
  id: string
  version: number
  instructions: string
  /** Null for versions saved in the old configuration format. */
  config: EmployeeConfig | null
  changeNote: string | null
  createdAt: string
  createdBy: string | null
  testStatus: TestStatus
  passedRuns: number
  failedRuns: number
}

export interface EmployeeDetail {
  id: string
  name: string
  department: Department
  description: string | null
  state: LifecycleState
  templateKey: string | null
  currentVersionId: string | null
  activeVersionId: string | null
  activatedAt: string | null
  createdAt: string
  updatedAt: string
  versions: VersionView[]
}

export async function getEmployee(organizationId: string, employeeId: string): Promise<EmployeeDetail | null> {
  const supabase = await createUserClient()
  const { data: employee, error } = await supabase
    .from('ai_employees')
    .select('id, name, role_category, description, lifecycle_status, template_key, current_version_id, active_version_id, activated_at, created_at, updated_at')
    .eq('organization_id', organizationId)
    .eq('id', employeeId)
    .maybeSingle()
  if (error) fail('the employee', error)
  if (!employee) return null

  const [{ data: versions, error: versionError }, { data: summary, error: summaryError }] = await Promise.all([
    supabase
      .from('employee_versions')
      .select('id, version, instructions, config, config_schema_version, change_note, created_at, created_by')
      .eq('organization_id', organizationId)
      .eq('employee_id', employeeId)
      .order('version', { ascending: false })
      .limit(100),
    supabase.rpc('employee_test_summary', { p_employee_id: employeeId }),
  ])
  if (versionError) fail('employee versions', versionError)
  if (summaryError) fail('test results', summaryError)
  const byVersion = new Map((summary ?? []).map((entry) => [entry.version_id, entry]))

  return {
    id: employee.id,
    name: employee.name,
    department: employee.role_category as Department,
    description: employee.description,
    state: employee.lifecycle_status as LifecycleState,
    templateKey: employee.template_key,
    currentVersionId: employee.current_version_id,
    activeVersionId: employee.active_version_id,
    activatedAt: employee.activated_at,
    createdAt: employee.created_at,
    updatedAt: employee.updated_at,
    versions: versions.map((version) => {
      const parsed = version.config_schema_version === 2 ? employeeConfigSchema.safeParse(version.config) : null
      const tests = byVersion.get(version.id)
      return {
        id: version.id,
        version: version.version,
        instructions: version.instructions,
        config: parsed?.success ? parsed.data : null,
        changeNote: version.change_note,
        createdAt: version.created_at,
        createdBy: version.created_by,
        testStatus: asTestStatus(tests?.test_status),
        passedRuns: Number(tests?.passed_runs ?? 0),
        failedRuns: Number(tests?.failed_runs ?? 0),
      }
    }),
  }
}

export interface TestCaseView {
  id: string
  name: string
  input: string
  expectations: TestExpectations
}

export async function listTestCases(organizationId: string, employeeId: string): Promise<TestCaseView[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('employee_test_cases')
    .select('id, name, input, expectations')
    .eq('organization_id', organizationId)
    .eq('employee_id', employeeId)
    .order('created_at')
  if (error) fail('test cases', error)
  return data.map((row) => ({ id: row.id, name: row.name, input: row.input, expectations: testExpectationsSchema.catch({}).parse(row.expectations) }))
}

export interface TestRunView {
  id: string
  versionId: string
  testCaseId: string | null
  input: string
  result: TestRunResult
  outcome: RunOutcome | null
  reply: string | null
  transcript: TranscriptEntry[]
  checks: CheckResult[]
  model: string | null
  costMicros: number
  inputTokens: number
  outputTokens: number
  error: { code?: string; message?: string } | null
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string
  finishedAt: string | null
}

export async function listTestRuns(organizationId: string, employeeId: string, limit = 20): Promise<TestRunView[]> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('employee_test_runs')
    .select('id, version_id, test_case_id, input, result, outcome, reply, transcript, checks, model, cost_micros, input_tokens, output_tokens, error, review_note, reviewed_at, created_at, finished_at')
    .eq('organization_id', organizationId)
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) fail('test runs', error)
  return data.map((row) => ({
    id: row.id,
    versionId: row.version_id,
    testCaseId: row.test_case_id,
    input: row.input,
    result: row.result as TestRunResult,
    outcome: row.outcome as RunOutcome | null,
    reply: row.reply,
    transcript: Array.isArray(row.transcript) ? (row.transcript as unknown as TranscriptEntry[]) : [],
    checks: Array.isArray(row.checks) ? (row.checks as unknown as CheckResult[]) : [],
    model: row.model,
    costMicros: Number(row.cost_micros),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    error: (row.error as { code?: string; message?: string } | null) ?? null,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }))
}

export interface EditorOptions {
  connections: ConnectionOption[]
  sources: KnowledgeSourceOption[]
  skills: SkillOption[]
}

/** Connections, knowledge sources and skills the editor can choose from. */
export async function loadEditorOptions(organizationId: string): Promise<EditorOptions> {
  const supabase = await createUserClient()
  const [connections, sources, skills] = await Promise.all([
    listConnections(organizationId).catch(() => []),
    listKnowledgeSources(supabase, organizationId, { sourceType: 'file' }).catch(() => []),
    supabase
      .from('skills')
      .select('key, name, description, tool_keys, organization_id')
      .eq('status', 'active')
      .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
      .order('name'),
  ])
  if (skills.error) fail('skills', skills.error)
  return {
    connections: connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      label: connection.accountLabel ?? connection.displayName,
      status: connection.status,
    })),
    sources: sources.filter((source) => source.status !== 'archived').map((source) => ({ id: source.id, name: source.name, status: source.status })),
    skills: skills.data.map((skill) => ({ key: skill.key, name: skill.name, description: skill.description, toolKeys: skill.tool_keys })),
  }
}

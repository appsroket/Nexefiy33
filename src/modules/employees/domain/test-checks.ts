// Automatic checks applied to a test run's trace. A saved test case passes
// only when the run completed (or escalated, when that was expected) and every
// expectation holds; a free-form playground run waits for a reviewer.

import type { RunOutcome, TestExpectations, TestRunResult } from './types'

export interface TraceToolCall {
  toolKey: string
  /** The decision the action would get: run, wait for approval, or be blocked. */
  decision: 'allow' | 'require_approval' | 'deny' | 'refused'
}

export interface RunTrace {
  outcome: RunOutcome
  reply: string
  toolCalls: TraceToolCall[]
}

export interface CheckResult {
  name: string
  passed: boolean
  detail: string
}

export function evaluateChecks(expectations: TestExpectations, trace: RunTrace): CheckResult[] {
  const used = new Set(trace.toolCalls.map((call) => call.toolKey))
  const checks: CheckResult[] = []
  const expectEscalation = expectations.mustEscalate === true

  checks.push({
    name: expectEscalation ? 'Escalated' : 'Finished',
    passed: expectEscalation ? trace.outcome === 'escalated' : trace.outcome === 'completed',
    detail: expectEscalation
      ? trace.outcome === 'escalated'
        ? 'The employee escalated as expected.'
        : `Expected an escalation; the run ended as “${trace.outcome}”.`
      : trace.outcome === 'completed'
        ? 'The run finished normally.'
        : `The run ended as “${trace.outcome}”.`,
  })

  for (const key of expectations.mustUseTools ?? []) {
    checks.push({ name: `Uses ${key}`, passed: used.has(key), detail: used.has(key) ? 'Used.' : 'Not used.' })
  }
  for (const key of expectations.mustNotUseTools ?? []) {
    checks.push({ name: `Doesn’t use ${key}`, passed: !used.has(key), detail: used.has(key) ? 'Used, but it shouldn’t be.' : 'Not used.' })
  }
  for (const key of expectations.mustRequestApproval ?? []) {
    const calls = trace.toolCalls.filter((call) => call.toolKey === key)
    const passed = calls.length > 0 && calls.every((call) => call.decision === 'require_approval')
    checks.push({
      name: `${key} waits for approval`,
      passed,
      detail: calls.length === 0 ? 'The tool wasn’t used.' : passed ? 'Every call would wait for approval.' : 'At least one call would run without approval.',
    })
  }
  const reply = trace.reply.toLowerCase()
  for (const phrase of expectations.replyMustMention ?? []) {
    const found = reply.includes(phrase.toLowerCase())
    checks.push({ name: `Mentions “${phrase}”`, passed: found, detail: found ? 'Found in the reply.' : 'Not in the reply.' })
  }
  return checks
}

export function hasExpectations(expectations: TestExpectations): boolean {
  return Boolean(
    expectations.mustUseTools?.length ||
      expectations.mustNotUseTools?.length ||
      expectations.mustRequestApproval?.length ||
      expectations.replyMustMention?.length ||
      expectations.mustEscalate,
  )
}

/** The stored result: errors stay errors; free-form runs go to a reviewer. */
export function runResult(trace: RunTrace, checks: CheckResult[], fromTestCase: boolean): TestRunResult {
  if (trace.outcome === 'error') return 'error'
  if (!fromTestCase) return trace.outcome === 'completed' || trace.outcome === 'escalated' ? 'needs_review' : 'failed'
  return checks.every((check) => check.passed) ? 'passed' : 'failed'
}

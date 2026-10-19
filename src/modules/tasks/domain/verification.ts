// Verifying a task's result.
//
// What an employee says is never proof that something happened. The only
// proof is the platform's own record: a tool execution the integration
// executor marked "succeeded" after the provider answered with a response that
// passed the action's output schema. So the result is checked against the
// executions recorded for the task (re-read from the database by the caller),
// not against the model's words:
//
//   receipts_verified  every receipt the employee cites is a succeeded action
//                      of this task (fails the task otherwise);
//   claims_backed      the report doesn't describe a change or a sent message
//                      when no such action succeeded (a heuristic on wording,
//                      so a mismatch needs review rather than failing);
//   actions_settled    no action is still waiting for approval or running;
//   actions_failed     no action failed or ended with an unknown outcome
//                      (needs review: the employee may have worked around it).

export interface ObservedAction {
  executionId: string
  toolKey: string
  /** read actions never change anything. */
  risk: 'read' | 'write_internal' | 'write_external' | 'sensitive'
  status: string
  errorCode: string | null
}

export interface TaskReport {
  status: 'completed' | 'partially_completed' | 'not_completed'
  summary: string
  receipts: string[]
  /** Values a workflow step asked for (plain text, scrubbed); absent for other tasks. */
  outputs?: Record<string, string>
}

export type CheckStatus = 'passed' | 'failed' | 'needs_review'

export interface VerificationCheck {
  key: 'receipts_verified' | 'claims_backed' | 'actions_settled' | 'actions_failed' | 'report_filed'
  status: CheckStatus
  detail: string
}

export interface Verification {
  status: 'verified' | 'needs_review' | 'failed'
  checks: VerificationCheck[]
}

const WRITE_CLAIM =
  /\b(i(?:'ve| have)?\s+)?(created|added|updated|changed|logged|recorded|saved|posted|sent|messaged|notified|scheduled|deleted|removed)\b/i
const NEGATED_CLAIM = /\b(not|n't|never|couldn't|could not|didn't|did not|wasn't|was not|unable|waiting|needs? approval|pending)\b/i

/** True when the text says, without negation, that something was changed or sent. */
export function claimsChange(text: string): boolean {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .some((sentence) => WRITE_CLAIM.test(sentence) && !NEGATED_CLAIM.test(sentence))
}

function isWrite(action: ObservedAction): boolean {
  return action.risk !== 'read'
}

export function verifyTaskResult(input: { report: TaskReport | null; reply: string; actions: readonly ObservedAction[] }): Verification {
  const { report, actions } = input
  const checks: VerificationCheck[] = []
  const byId = new Map(actions.map((action) => [action.executionId, action]))

  const receipts = report?.receipts ?? []
  const bad = receipts.filter((receipt) => byId.get(receipt)?.status !== 'succeeded')
  checks.push(
    bad.length
      ? { key: 'receipts_verified', status: 'failed', detail: `The employee cited ${bad.length === 1 ? 'an action' : `${bad.length} actions`} that didn’t succeed in this task: ${bad.join(', ')}.` }
      : { key: 'receipts_verified', status: 'passed', detail: receipts.length ? `All ${receipts.length} cited action(s) succeeded.` : 'No actions cited.' },
  )

  const succeededWrites = actions.filter((action) => isWrite(action) && action.status === 'succeeded')
  const text = `${report?.summary ?? ''}\n${input.reply}`
  checks.push(
    claimsChange(text) && succeededWrites.length === 0
      ? { key: 'claims_backed', status: 'needs_review', detail: 'The report describes a change or a sent message, but no action that changes data or sends something succeeded in this task.' }
      : { key: 'claims_backed', status: 'passed', detail: succeededWrites.length ? `${succeededWrites.length} change(s) confirmed by the platform.` : 'The report doesn’t claim any change.' },
  )

  const unsettled = actions.filter((action) => ['proposed', 'awaiting_approval', 'approved', 'executing'].includes(action.status))
  checks.push(
    unsettled.length
      ? { key: 'actions_settled', status: 'needs_review', detail: `${unsettled.length} action(s) haven’t finished.` }
      : { key: 'actions_settled', status: 'passed', detail: 'Every action finished.' },
  )

  const failed = actions.filter((action) => action.status === 'failed')
  const unknown = failed.filter((action) => action.errorCode === 'outcome_unknown')
  checks.push(
    failed.length
      ? {
          key: 'actions_failed',
          status: 'needs_review',
          detail: unknown.length
            ? `${failed.length} action(s) failed; for ${unknown.length} it’s unknown whether it happened — check the provider before retrying.`
            : `${failed.length} action(s) failed.`,
        }
      : { key: 'actions_failed', status: 'passed', detail: 'No action failed.' },
  )

  checks.push(
    report
      ? { key: 'report_filed', status: 'passed', detail: 'The employee filed a structured report.' }
      : { key: 'report_filed', status: 'needs_review', detail: 'The employee answered without a structured report.' },
  )

  const status = checks.some((check) => check.status === 'failed') ? 'failed' : checks.some((check) => check.status === 'needs_review') ? 'needs_review' : 'verified'
  return { status, checks }
}

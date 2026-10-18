'use client'

// The test playground: run the latest saved version on a free-form request or
// a saved test case, read exactly what it did (every tool call with the
// decision it got), see the automatic checks, and record a verdict. Runs use
// the real model; reads may return real data; nothing that changes data or
// sends a message is carried out.

import { Bot, CircleAlert, CircleCheck, CircleX, FlaskConical, Play, Plus, ShieldAlert, Trash2, User, Wrench } from 'lucide-react'
import { useActionState, useState, useTransition } from 'react'

import { SectionCard } from '@/components/cards'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DateTime } from '@/components/date-time'
import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { TextAreaField, TextField } from '@/components/forms/text-field'
import { StatusIndicator } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type { ActionState } from '@/lib/forms/action-state'
import { formatUsd } from '@/modules/models/domain/catalog'

import type { CheckResult } from '../domain/test-checks'
import type { EmployeeToolInfo } from '../domain/types'
import { deleteTestCase, reviewTestRun, runTestAction, saveTestCaseAction, type TestRunState } from '../server/actions'
import type { TestCaseView, TestRunView } from '../server/queries'
import type { TranscriptEntry } from '../server/runtime'
import { DECISION_LABELS, OUTCOME_LABELS, RUN_RESULT_DISPLAY, SELECT_CLASS } from './labels'

const IDLE: TestRunState = { status: 'idle' }

export function Transcript({ entries }: { entries: readonly TranscriptEntry[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {entries.map((entry, index) => (
        <li key={index} className="flex gap-3 text-sm">
          {entry.kind === 'request' ? (
            <>
              <User className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Request" />
              <p className="whitespace-pre-wrap">{entry.text}</p>
            </>
          ) : entry.kind === 'assistant' ? (
            <>
              <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Employee" />
              <p className="whitespace-pre-wrap">{entry.text}</p>
            </>
          ) : entry.kind === 'tool_call' ? (
            <>
              <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Tool call" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs font-semibold">{entry.toolKey}</code>
                  <StatusIndicator
                    tone={entry.decision === 'allow' ? 'success' : entry.decision === 'require_approval' ? 'warning' : 'danger'}
                    label={entry.executed ? 'Ran' : DECISION_LABELS[entry.decision]}
                  />
                  {!entry.executed && entry.decision !== 'refused' ? <span className="text-xs text-muted-foreground">Not carried out (test run)</span> : null}
                </div>
                <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(entry.input, null, 2)}</pre>
                <pre className={`max-h-40 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap ${entry.isError ? 'bg-destructive/10' : 'bg-muted/60'}`}>{entry.result}</pre>
              </div>
            </>
          ) : entry.kind === 'escalation' ? (
            <>
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Escalation" />
              <div>
                <p className="font-medium">Escalated: {entry.reason}</p>
                <p className="whitespace-pre-wrap">{entry.message}</p>
              </div>
            </>
          ) : (
            <>
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Stopped" />
              <p className="text-muted-foreground">{entry.reason}</p>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}

function Checks({ checks }: { checks: readonly CheckResult[] }) {
  if (!checks.length) return null
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {checks.map((check) => (
        <li key={check.name} className="flex items-start gap-2">
          {check.passed ? <CircleCheck className="mt-0.5 size-4 text-success" aria-label="Passed" /> : <CircleX className="mt-0.5 size-4 text-destructive" aria-label="Failed" />}
          <span>
            <span className="font-medium">{check.name}</span> <span className="text-muted-foreground">{check.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function ReviewButtons({ organizationId, employeeId, run }: { organizationId: string; employeeId: string; run: Pick<TestRunView, 'id' | 'result'> }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionState | null>(null)
  const [note, setNote] = useState('')
  if (run.result !== 'needs_review' && run.result !== 'passed') return null
  const review = (verdict: 'passed' | 'failed') => startTransition(async () => setResult(await reviewTestRun(organizationId, employeeId, run.id, verdict, note)))
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <Field>
        <FieldLabel htmlFor={`note-${run.id}`} className="text-xs">
          Review note (optional)
        </FieldLabel>
        <Textarea id={`note-${run.id}`} rows={2} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} />
      </Field>
      <div className="flex flex-wrap gap-2">
        {run.result === 'needs_review' ? (
          <Button size="sm" onClick={() => review('passed')} disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <CircleCheck data-icon="inline-start" aria-hidden="true" />}
            Mark as passed
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => review('failed')} disabled={pending}>
          <CircleX data-icon="inline-start" aria-hidden="true" />
          Mark as failed
        </Button>
      </div>
      {result?.status === 'error' ? <p className="text-sm text-destructive" role="alert">{result.message}</p> : null}
      {result?.status === 'success' ? <p className="text-sm" role="status">{result.message}</p> : null}
    </div>
  )
}

export function Playground({
  organizationId,
  employeeId,
  currentVersionId,
  currentVersion,
  canRun,
  modelConfigured,
  testCases,
  runs,
  tools,
}: {
  organizationId: string
  employeeId: string
  currentVersionId: string
  currentVersion: number
  canRun: boolean
  modelConfigured: boolean
  testCases: TestCaseView[]
  runs: TestRunView[]
  tools: EmployeeToolInfo[]
}) {
  const [state, formAction, pending] = useActionState(runTestAction, IDLE)
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(testCases.length === 0)
  const latestByCase = new Map<string, TestRunView>()
  for (const run of runs) if (run.testCaseId && run.versionId === currentVersionId && !latestByCase.has(run.testCaseId)) latestByCase.set(run.testCaseId, run)

  return (
    <div className="flex flex-col gap-6">
      {!modelConfigured ? (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>No AI model is configured on this deployment</AlertTitle>
          <AlertDescription>Test runs need a real model: an Anthropic API key has to be added to this deployment (see docs/credential-setup.md). Nothing is simulated, so runs are unavailable until then.</AlertDescription>
        </Alert>
      ) : null}

      <SectionCard title={`Try version ${currentVersion}`} description="Free-form runs are judged by you: mark them passed or failed below.">
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="employeeId" value={employeeId} />
          <Field>
            <FieldLabel htmlFor="playground-input">Request</FieldLabel>
            <Textarea id="playground-input" name="input" rows={4} maxLength={4000} value={input} onChange={(event) => setInput(event.target.value)} />
            <FieldDescription>Write it the way a teammate would ask. Reads may use real data from your connections; changes and messages are not carried out.</FieldDescription>
          </Field>
          <div>
            <Button type="submit" disabled={!canRun || !modelConfigured || pending || !input.trim()}>
              {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Play data-icon="inline-start" aria-hidden="true" />}
              Run
            </Button>
          </div>
        </form>
        <div aria-live="polite" className="mt-4">
          {state.status === 'error' ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}
          {state.status === 'done' ? (
            <div className="flex flex-col gap-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusIndicator tone={RUN_RESULT_DISPLAY[state.result].tone} label={RUN_RESULT_DISPLAY[state.result].label} />
                <span>{OUTCOME_LABELS[state.outcome]}</span>
                <span className="text-muted-foreground">
                  {state.model} · {formatUsd(state.costMicros)}
                </span>
              </div>
              <Checks checks={state.checks} />
              <Transcript entries={state.transcript} />
              <ReviewButtons organizationId={organizationId} employeeId={employeeId} run={{ id: state.runId, result: state.result }} />
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Test cases"
        description="Saved requests with expectations, checked automatically. Every test case must pass on a version before it can be activated."
        action={
          canRun && !adding ? (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add test case
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          {testCases.length ? (
            <ul className="flex flex-col divide-y">
              {testCases.map((testCase) => {
                const latest = latestByCase.get(testCase.id)
                return (
                  <li key={testCase.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:justify-between">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="font-medium">{testCase.name}</p>
                      <p className="text-sm whitespace-pre-wrap text-muted-foreground">{testCase.input}</p>
                      <ExpectationList expectations={testCase.expectations} />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {latest ? (
                        <StatusIndicator tone={RUN_RESULT_DISPLAY[latest.result].tone} label={`v${currentVersion}: ${RUN_RESULT_DISPLAY[latest.result].label}`} />
                      ) : (
                        <StatusIndicator tone="neutral" label={`Not run on v${currentVersion}`} />
                      )}
                      <form action={formAction}>
                        <input type="hidden" name="organizationId" value={organizationId} />
                        <input type="hidden" name="employeeId" value={employeeId} />
                        <input type="hidden" name="testCaseId" value={testCase.id} />
                        <Button type="submit" size="sm" disabled={!canRun || !modelConfigured || pending}>
                          <FlaskConical data-icon="inline-start" aria-hidden="true" />
                          Run
                        </Button>
                      </form>
                      {canRun ? (
                        <ConfirmDialog
                          trigger={
                            <Button size="icon-sm" variant="ghost" aria-label={`Delete ${testCase.name}`}>
                              <Trash2 aria-hidden="true" />
                            </Button>
                          }
                          title={`Delete “${testCase.name}”?`}
                          description="Its past runs are kept, but it no longer counts toward activation."
                          confirmLabel="Delete"
                          destructive
                          onConfirm={() => deleteTestCase(organizationId, employeeId, testCase.id)}
                        />
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No test cases yet. Add one for each success criterion you care about.</p>
          )}
          {adding && canRun ? <TestCaseForm organizationId={organizationId} employeeId={employeeId} tools={tools} onDone={() => setAdding(false)} /> : null}
        </div>
      </SectionCard>

      <SectionCard title="Recent runs">
        {runs.length ? (
          <ul className="flex flex-col divide-y">
            {runs.map((run) => (
              <li key={run.id} className="py-3">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                    <StatusIndicator tone={RUN_RESULT_DISPLAY[run.result].tone} label={RUN_RESULT_DISPLAY[run.result].label} />
                    <span className="font-medium">{run.testCaseId ? (testCases.find((testCase) => testCase.id === run.testCaseId)?.name ?? 'Deleted test case') : 'Free-form'}</span>
                    {run.versionId !== currentVersionId ? <span className="text-xs text-muted-foreground">(older version)</span> : null}
                    <span className="text-muted-foreground">
                      <DateTime value={run.createdAt} /> · {run.model ?? '—'} · {formatUsd(run.costMicros)}
                    </span>
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    {run.outcome ? <p className="text-sm">{OUTCOME_LABELS[run.outcome]}</p> : null}
                    {run.error?.message ? <p className="text-sm text-destructive">{run.error.message}</p> : null}
                    {run.reviewNote ? <p className="text-sm text-muted-foreground">Review note: {run.reviewNote}</p> : null}
                    <Checks checks={run.checks} />
                    <Transcript entries={run.transcript} />
                    {canRun ? <ReviewButtons organizationId={organizationId} employeeId={employeeId} run={run} /> : null}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
      </SectionCard>
    </div>
  )
}

function ExpectationList({ expectations }: { expectations: TestCaseView['expectations'] }) {
  const items = [
    ...(expectations.mustUseTools ?? []).map((key) => `uses ${key}`),
    ...(expectations.mustNotUseTools ?? []).map((key) => `doesn’t use ${key}`),
    ...(expectations.mustRequestApproval ?? []).map((key) => `${key} waits for approval`),
    ...(expectations.replyMustMention ?? []).map((phrase) => `mentions “${phrase}”`),
    ...(expectations.mustEscalate ? ['escalates'] : []),
  ]
  return items.length ? <p className="text-xs text-muted-foreground">Expects: {items.join(' · ')}</p> : <p className="text-xs text-muted-foreground">Expects: finishes normally</p>
}

function ToolChecklist({ name, label, tools }: { name: string; label: string; tools: EmployeeToolInfo[] }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <select name={name} multiple className={`${SELECT_CLASS} h-28`} aria-label={label}>
        {tools.map((tool) => (
          <option key={tool.key} value={tool.key}>
            {tool.title}
          </option>
        ))}
      </select>
    </fieldset>
  )
}

function TestCaseForm({ organizationId, employeeId, tools, onDone }: { organizationId: string; employeeId: string; tools: EmployeeToolInfo[]; onDone: () => void }) {
  return (
    <ActionForm action={saveTestCaseAction} onSuccess={onDone} className="flex flex-col gap-3 rounded-lg border p-4" aria-label="New test case">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <TextField name="name" label="Name" required maxLength={120} placeholder="Checks for duplicates before creating a contact" />
      <TextAreaField name="input" label="Request" required rows={3} maxLength={4000} placeholder="A new lead came in: Jane Doe, jane@example.com, wants a demo." />
      <div className="grid gap-3 md:grid-cols-3">
        <ToolChecklist name="mustUseTools" label="Must use" tools={tools} />
        <ToolChecklist name="mustNotUseTools" label="Must not use" tools={tools} />
        <ToolChecklist name="mustRequestApproval" label="Must wait for approval" tools={tools.filter((tool) => tool.risk !== 'read')} />
      </div>
      <TextAreaField name="replyMustMention" label="Reply must mention" rows={2} description="One phrase per line (case doesn’t matter)." />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="mustEscalate" className="accent-primary" /> The employee should escalate instead of answering
      </label>
      <FormMessage />
      <div className="flex gap-2">
        <SubmitButton>Save test case</SubmitButton>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </ActionForm>
  )
}

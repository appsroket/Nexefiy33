'use client'

// A read-only view of an activated version or of a run: the same canvas,
// with each step's settings (versions) or what happened at it (runs).

import { useMemo, useState } from 'react'

import { STEP_STATUS_DISPLAY, type BuilderContext, type StepStatus, type WorkflowDefinition, type WorkflowLayout } from '../domain/types'
import { StepForm } from './step-form'
import { stepSubtitles, WorkflowCanvas } from './workflow-canvas'

export interface RunStepView {
  status: StepStatus
  branch: string | null
  attempt: number
  taskId: string | null
  input: unknown
  output: unknown
  error: { code?: string; message?: string } | null
}

const noop = () => {}

export function WorkflowViewer({
  definition,
  layout,
  context,
  steps,
}: {
  definition: WorkflowDefinition
  layout: WorkflowLayout
  context: BuilderContext
  /** For a run: what happened at each step it reached. */
  steps?: Record<string, RunStepView>
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const subtitles = useMemo(
    () => stepSubtitles(definition, { employees: new Map(context.employees.map((employee) => [employee.id, employee.name])), tools: new Map(context.tools.map((tool) => [tool.key, tool.title])) }),
    [definition, context],
  )
  const statuses = useMemo(() => (steps ? Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, step.status])) : undefined), [steps])
  const selected = definition.nodes.find((node) => node.id === selectedId) ?? null
  const step = selected && steps ? steps[selected.id] : undefined

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <WorkflowCanvas definition={definition} layout={layout} subtitles={subtitles} {...(statuses ? { statuses } : {})} selectedId={selectedId} readOnly onSelect={setSelectedId} />
      <aside className="flex max-h-[560px] flex-col gap-3 overflow-y-auto rounded-lg border p-3" aria-label="Selected step">
        {!selected ? (
          <p className="text-sm text-muted-foreground">Select a step to see {steps ? 'what happened there' : 'its settings'}.</p>
        ) : steps ? (
          <div className="flex flex-col gap-2 text-sm">
            <h3 className="font-semibold">{selected.label || selected.id}</h3>
            {step ? (
              <>
                <p>
                  {STEP_STATUS_DISPLAY[step.status].label}
                  {step.branch ? ` — took the “${step.branch}” path` : ''}
                  {step.attempt > 1 ? ` (attempt ${step.attempt})` : ''}
                </p>
                {step.taskId ? (
                  <a href={`/app/tasks/${step.taskId}`} className="underline underline-offset-4">
                    Open the step’s task
                  </a>
                ) : null}
                {step.error ? <p className="text-destructive">{step.error.message ?? step.error.code}</p> : null}
                {step.input ? (
                  <>
                    <span className="font-medium">Input</span>
                    <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{JSON.stringify(step.input, null, 2)}</pre>
                  </>
                ) : null}
                {step.output !== null && step.output !== undefined ? (
                  <>
                    <span className="font-medium">Output</span>
                    <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{JSON.stringify(step.output, null, 2)}</pre>
                  </>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">The run hasn’t reached this step.</p>
            )}
          </div>
        ) : (
          <StepForm key={selected.id} node={selected} definition={definition} context={context} issues={[]} readOnly onChange={noop} onRename={noop} onDelete={noop} onConnect={noop} onDisconnect={noop} />
        )}
      </aside>
    </div>
  )
}

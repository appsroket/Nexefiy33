'use client'

// The workflow builder: one draft, edited three ways — on the canvas, as a
// list of step forms, or as JSON — with live validation, undo/redo, saving
// with optimistic locking (a teammate's newer save is never overwritten) and,
// for admins, activation. Activation sends nothing from the browser but the
// typed confirmation: the server validates the saved draft again with
// everything read from the database (resources, permissions, policies) and
// only then creates an immutable version.

import { CircleAlert, CircleCheck, Plus, Redo2, Rocket, Save, TriangleAlert, Undo2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

import { newEdgeId, newNode, normalizeDefinition, reconcileLayout, removeNode, renameNode } from '../domain/factory'
import { NODE_TYPE_INFO, NODE_TYPES, type Branch, type BuilderContext, type NodeType, type WorkflowDefinition, type WorkflowLayout, type WorkflowNode } from '../domain/types'
import { validateWorkflow, type ValidationIssue } from '../domain/validation'
import { activateWorkflowAction, saveWorkflowDraftAction, type ActivateResult } from '../server/actions'
import { InputsEditor } from './inputs-editor'
import { DECISION_TEXT, NODE_ICONS, RISK_TEXT } from './labels'
import { StepForm } from './step-form'
import { stepSubtitles, WorkflowCanvas } from './workflow-canvas'

interface Snapshot {
  definition: WorkflowDefinition
  layout: WorkflowLayout
}

const HISTORY_LIMIT = 50

export function WorkflowEditor({
  organizationId,
  workflowId,
  initialName,
  initialDescription,
  initialDefinition,
  initialLayout,
  initialLockVersion,
  context,
  canEdit,
  canActivate,
  archived,
  notes,
  unsupported,
}: {
  organizationId: string
  workflowId: string
  initialName: string
  initialDescription: string
  initialDefinition: WorkflowDefinition
  initialLayout: WorkflowLayout
  initialLockVersion: number
  context: BuilderContext
  canEdit: boolean
  canActivate: boolean
  archived: boolean
  notes: string[]
  unsupported: string[]
}) {
  const router = useRouter()
  const readOnly = !canEdit || archived
  const [current, setCurrent] = useState<Snapshot>({ definition: initialDefinition, layout: reconcileLayout(initialDefinition, initialLayout) })
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [lockVersion, setLockVersion] = useState(initialLockVersion)
  const [dirty, setDirty] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [saving, startSaving] = useTransition()
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const { definition, layout } = current

  const report = useMemo(() => validateWorkflow(definition, { mode: 'activation', context }), [definition, context])
  const issuesByNode = useMemo(() => {
    const map: Record<string, ValidationIssue[]> = {}
    for (const issue of [...report.errors, ...report.warnings]) if (issue.nodeId) (map[issue.nodeId] ??= []).push(issue)
    return map
  }, [report])
  const issueCounts = useMemo(
    () => Object.fromEntries(Object.entries(issuesByNode).map(([id, list]) => [id, { errors: list.filter((issue) => issue.severity === 'error').length, warnings: list.filter((issue) => issue.severity === 'warning').length }])),
    [issuesByNode],
  )
  const subtitles = useMemo(
    () => stepSubtitles(definition, { employees: new Map(context.employees.map((employee) => [employee.id, employee.name])), tools: new Map(context.tools.map((tool) => [tool.key, tool.title])) }),
    [definition, context],
  )
  const selected = definition.nodes.find((node) => node.id === selectedId) ?? null

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const apply = useCallback(
    (change: (snapshot: Snapshot) => Snapshot, options: { history?: boolean } = {}) => {
      if (readOnly) return
      setCurrent((previous) => {
        const next = change(previous)
        if (options.history !== false) {
          setPast((items) => [...items.slice(-HISTORY_LIMIT + 1), previous])
          setFuture([])
        }
        return next
      })
      setDirty(true)
      setMessage(null)
    },
    [readOnly],
  )
  const setDefinition = (next: WorkflowDefinition) => apply((snapshot) => ({ definition: next, layout: reconcileLayout(next, snapshot.layout) }))
  const updateNode = (node: WorkflowNode) => apply((snapshot) => ({ ...snapshot, definition: { ...snapshot.definition, nodes: snapshot.definition.nodes.map((item) => (item.id === node.id ? node : item)) } }))

  const undo = () => {
    const previous = past.at(-1)
    if (!previous) return
    setFuture((items) => [current, ...items])
    setPast((items) => items.slice(0, -1))
    setCurrent(previous)
    setDirty(true)
  }
  const redo = () => {
    const next = future[0]
    if (!next) return
    setPast((items) => [...items, current])
    setFuture((items) => items.slice(1))
    setCurrent(next)
    setDirty(true)
  }

  const addStep = (type: NodeType) => {
    const node = newNode(type, definition.nodes)
    const anchor = (selectedId && layout[selectedId]) || Object.values(layout).reduce((lowest, position) => (position.y > lowest.y ? position : lowest), { x: 0, y: 0 })
    // Below the anchor, moved sideways until it doesn't sit on another step.
    const spot = { x: anchor.x, y: anchor.y + 150 }
    const taken = Object.values(layout)
    for (let tries = 0; tries < 20 && taken.some((position) => Math.abs(position.x - spot.x) < 250 && Math.abs(position.y - spot.y) < 110); tries++) spot.x += 280
    apply((snapshot) => {
      const nodes = [...snapshot.definition.nodes, node]
      const edges = selectedId && NODE_TYPE_INFO[snapshot.definition.nodes.find((item) => item.id === selectedId)?.type ?? 'end'].branches.includes('') && type !== 'trigger'
        ? [...snapshot.definition.edges, { id: newEdgeId(snapshot.definition.edges), source: selectedId, target: node.id }]
        : snapshot.definition.edges
      return { definition: { ...snapshot.definition, nodes, edges }, layout: { ...snapshot.layout, [node.id]: spot } }
    })
    setSelectedId(node.id)
  }
  const connect = (edge: { source: string; target: string; branch?: Branch }) => {
    if (definition.edges.some((item) => item.source === edge.source && item.target === edge.target && (item.branch ?? '') === (edge.branch ?? ''))) return
    apply((snapshot) => ({ ...snapshot, definition: { ...snapshot.definition, edges: [...snapshot.definition.edges, { id: newEdgeId(snapshot.definition.edges), ...edge }] } }))
  }
  const disconnect = (ids: string[]) => apply((snapshot) => ({ ...snapshot, definition: { ...snapshot.definition, edges: snapshot.definition.edges.filter((edge) => !ids.includes(edge.id)) } }))
  const remove = (ids: string[]) => {
    apply((snapshot) => {
      const next = ids.reduce((definitionSoFar, id) => removeNode(definitionSoFar, id), snapshot.definition)
      return { definition: next, layout: reconcileLayout(next, snapshot.layout) }
    })
    if (selectedId && ids.includes(selectedId)) setSelectedId(null)
  }
  const rename = (from: string, to: string) => {
    apply((snapshot) => {
      const next = renameNode(snapshot.definition, from, to)
      const { [from]: position, ...rest } = snapshot.layout
      return { definition: next, layout: { ...rest, [to]: position ?? { x: 0, y: 0 } } }
    })
    setSelectedId(to)
  }

  const save = () =>
    startSaving(async () => {
      const result = await saveWorkflowDraftAction({ organizationId, workflowId, lockVersion, name, description, definition, layout })
      if (result.status === 'saved') {
        setLockVersion(result.lockVersion)
        setDirty(false)
        setMessage({ tone: 'success', text: result.report.valid ? 'Saved. No problems found.' : `Saved as a draft with ${result.report.errors.length} problem(s) to fix before activation.` })
        router.refresh()
      } else {
        setMessage({ tone: 'error', text: result.issues?.length ? `${result.message} (${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')})` : result.message })
      }
    })

  const nodeIssues = (id: string) => issuesByNode[id] ?? []
  const stepForm = (node: WorkflowNode) => (
    <StepForm
      key={node.id}
      node={node}
      definition={definition}
      context={context}
      issues={nodeIssues(node.id)}
      readOnly={readOnly}
      onChange={updateNode}
      onRename={rename}
      onDelete={(id) => remove([id])}
      onConnect={connect}
      onDisconnect={(id) => disconnect([id])}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      {notes.length || unsupported.length ? (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>How this draft was made</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
              {unsupported.map((item) => (
                <li key={item}>Not included: {item}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <Field>
          <FieldLabel htmlFor="workflow-name">Name</FieldLabel>
          <Input id="workflow-name" value={name} maxLength={200} disabled={readOnly} onChange={(event) => (setName(event.target.value), setDirty(true))} />
        </Field>
        <Field>
          <FieldLabel htmlFor="workflow-description">Description</FieldLabel>
          <Input id="workflow-description" value={description} maxLength={2000} disabled={readOnly} onChange={(event) => (setDescription(event.target.value), setDirty(true))} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!readOnly ? (
          <>
            <Button type="button" onClick={save} disabled={saving || !dirty}>
              {saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Save data-icon="inline-start" aria-hidden="true" />}
              Save draft
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={undo} disabled={!past.length} aria-label="Undo">
              <Undo2 aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={redo} disabled={!future.length} aria-label="Redo">
              <Redo2 aria-hidden="true" />
            </Button>
          </>
        ) : null}
        {canActivate && !archived ? (
          <ActivateDialog
            organizationId={organizationId}
            workflowId={workflowId}
            name={name}
            lockVersion={lockVersion}
            disabled={dirty || !report.valid}
            onActivated={(version) => {
              setLockVersion(version.lockVersion)
              setMessage({ tone: 'success', text: `Version ${version.version} is active. Runs use exactly this version.` })
              router.refresh()
            }}
          />
        ) : null}
        <span className="text-sm text-muted-foreground" role="status">
          {dirty ? 'Unsaved changes' : 'All changes saved'}
          {canActivate && dirty ? ' — save before activating' : ''}
        </span>
      </div>
      {message ? (
        <Alert variant={message.tone === 'error' ? 'destructive' : 'default'} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.tone === 'error' ? <CircleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}

      <ValidationSummary errors={report.errors} warnings={report.warnings} onSelect={setSelectedId} />

      <Tabs defaultValue="canvas">
        <TabsList>
          <TabsTrigger value="canvas">Canvas</TabsTrigger>
          <TabsTrigger value="steps">Steps</TabsTrigger>
          <TabsTrigger value="inputs">Inputs &amp; limits</TabsTrigger>
          <TabsTrigger value="json" onClick={() => (setJsonText(JSON.stringify(definition, null, 2)), setJsonError(null))}>
            JSON
          </TabsTrigger>
        </TabsList>

        <TabsContent value="canvas" className="flex flex-col gap-3">
          {!readOnly ? (
            <div className="flex flex-wrap gap-2" aria-label="Add a step">
              {NODE_TYPES.filter((type) => type !== 'trigger' || !definition.nodes.some((node) => node.type === 'trigger')).map((type) => {
                const Icon = NODE_ICONS[type]
                return (
                  <Button key={type} type="button" variant="outline" size="sm" onClick={() => addStep(type)} title={NODE_TYPE_INFO[type].description}>
                    <Icon data-icon="inline-start" aria-hidden="true" />
                    {NODE_TYPE_INFO[type].label}
                  </Button>
                )
              })}
            </div>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <WorkflowCanvas
              definition={definition}
              layout={layout}
              subtitles={subtitles}
              issueCounts={issueCounts}
              selectedId={selectedId}
              readOnly={readOnly}
              onSelect={setSelectedId}
              onLayoutChange={(next) => apply((snapshot) => ({ ...snapshot, layout: next }), { history: false })}
              onConnect={connect}
              onRemoveNodes={remove}
              onRemoveEdges={disconnect}
            />
            <aside className="flex max-h-[560px] flex-col gap-3 overflow-y-auto rounded-lg border p-3" aria-label="Selected step">
              {selected ? (
                stepForm(selected)
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select a step to change its settings{readOnly ? '' : ', drag from a step’s handle to another step to connect them, or add a step above (it follows the selected step)'}. Press Delete to remove a selected step or connection.
                </p>
              )}
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="steps" className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Every step’s settings and connections as forms — the same workflow as the canvas.</p>
          {definition.nodes.map((node) => {
            const Icon = NODE_ICONS[node.type]
            return (
              <details key={node.id} className="rounded-lg border p-3" open={node.id === selectedId}>
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <Icon className="size-4" aria-hidden="true" />
                  {node.label || node.id}
                  <span className="text-xs font-normal text-muted-foreground">{NODE_TYPE_INFO[node.type].label}</span>
                  {issueCounts[node.id]?.errors ? <span className="text-xs text-destructive">{issueCounts[node.id]!.errors} problem(s)</span> : null}
                </summary>
                <div className="mt-3">{stepForm(node)}</div>
              </details>
            )
          })}
          {!readOnly ? (
            <div className="flex flex-wrap gap-2">
              {NODE_TYPES.filter((type) => type !== 'trigger').map((type) => (
                <Button key={type} type="button" variant="outline" size="sm" onClick={() => addStep(type)}>
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  {NODE_TYPE_INFO[type].label}
                </Button>
              ))}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="inputs">
          <InputsEditor definition={definition} readOnly={readOnly} onChange={setDefinition} />
        </TabsContent>

        <TabsContent value="json" className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">The workflow definition (graph schema version 2). Edit and apply to replace the draft; it is checked like any other change.</p>
          <Textarea aria-label="Workflow JSON" value={jsonText} onChange={(event) => setJsonText(event.target.value)} rows={24} className="font-mono text-xs" readOnly={readOnly} />
          {jsonError ? <p className="text-sm text-destructive">{jsonError}</p> : null}
          {!readOnly ? (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => {
                let parsed: unknown
                try {
                  parsed = JSON.parse(jsonText)
                } catch {
                  return setJsonError('That isn’t valid JSON.')
                }
                const normalized = normalizeDefinition(parsed)
                if (!normalized.ok) return setJsonError(normalized.message)
                setJsonError(null)
                setDefinition(normalized.definition)
              }}
            >
              Apply JSON
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ValidationSummary({ errors, warnings, onSelect }: { errors: ValidationIssue[]; warnings: ValidationIssue[]; onSelect: (id: string) => void }) {
  if (!errors.length && !warnings.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleCheck className="size-4 text-success" aria-hidden="true" />
        No problems found here. Activation also checks permissions and workspace policies on the server.
      </p>
    )
  }
  const item = (issue: ValidationIssue, position: number) => (
    <li key={position}>
      {issue.nodeId ? (
        <button type="button" className="text-left underline-offset-4 hover:underline" onClick={() => onSelect(issue.nodeId!)}>
          {issue.message}
        </button>
      ) : (
        issue.message
      )}
    </li>
  )
  return (
    <div className="flex flex-col gap-2">
      {errors.length ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{errors.length} problem(s) to fix before this can be activated</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">{errors.slice(0, 12).map(item)}</ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {warnings.length ? (
        <Alert>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{warnings.length} warning(s)</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">{warnings.slice(0, 12).map(item)}</ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

function ActivateDialog({
  organizationId,
  workflowId,
  name,
  lockVersion,
  disabled,
  onActivated,
}: {
  organizationId: string
  workflowId: string
  name: string
  lockVersion: number
  disabled: boolean
  onActivated: (result: { version: number; lockVersion: number }) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [result, setResult] = useState<ActivateResult | null>(null)
  const [pending, startTransition] = useTransition()
  return (
    <Dialog open={open} onOpenChange={(next) => (!pending ? (setOpen(next), setResult(null), setConfirm('')) : null)}>
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" disabled={disabled} title={disabled ? 'Save the draft and fix every problem first.' : undefined}>
          <Rocket data-icon="inline-start" aria-hidden="true" />
          Activate…
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Activate this workflow</DialogTitle>
          <DialogDescription>
            The saved draft is checked again on the server — employees, actions, connections, permissions and workspace policies — and becomes a new, unchangeable version. Runs use exactly that version, on your authority as an admin. Type the workflow’s name to confirm.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="activate-confirm">Workflow name</FieldLabel>
          <Input id="activate-confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder={name} autoComplete="off" />
          <FieldDescription>Type “{name}”.</FieldDescription>
        </Field>
        {result?.status === 'error' ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        ) : null}
        {result?.status === 'invalid' ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Not activated: {result.report.errors.length} problem(s)</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {result.report.errors.map((issue, position) => (
                  <li key={position}>{issue.message}</li>
                ))}
              </ul>
              {result.report.permissions.length ? (
                <>
                  <p className="mt-2 font-medium">What this workflow may do</p>
                  <ul className="list-disc pl-4">
                    {result.report.permissions.map((line, position) => (
                      <li key={position}>
                        {line.label}: {line.toolKey} — {RISK_TEXT[line.risk] ?? line.risk}; {DECISION_TEXT[line.decision] ?? line.decision}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            disabled={pending || confirm.trim().toLowerCase() !== name.trim().toLowerCase()}
            onClick={() =>
              startTransition(async () => {
                const outcome = await activateWorkflowAction({ organizationId, workflowId, lockVersion, confirmName: confirm })
                setResult(outcome)
                if (outcome.status === 'activated') {
                  setOpen(false)
                  onActivated(outcome)
                }
              })
            }
          >
            {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Rocket data-icon="inline-start" aria-hidden="true" />}
            Validate and activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

'use client'

// The settings of one step: manual configuration without AI, shared by the
// canvas's side panel and the step list. Every templated field offers the
// data the step may use (run inputs and the outputs of steps that always run
// before it), so references never need to be typed by hand. Nothing here is
// trusted: the server validates the whole workflow again.

import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

import { checkSchedule } from '../domain/schedule'
import {
  APPROVER_ROLES,
  BRANCH_LABELS,
  CONDITION_OPERATORS,
  FORMAT_LABELS,
  NODE_ID_PATTERN,
  NODE_TYPE_INFO,
  OPERATOR_LABELS,
  TRANSFORM_FORMATS,
  UNARY_OPERATORS,
  type Branch,
  type BuilderContext,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../domain/types'
import { referencesAvailableTo, type ReferenceOption, type ValidationIssue } from '../domain/validation'
import { RISK_TEXT, SELECT_CLASS } from './labels'

const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 9:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 9:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays at 9:00', cron: '0 9 * * 1' },
  { label: 'First day of the month at 9:00', cron: '0 9 1 * *' },
]

function TemplateInput({
  id,
  value,
  onChange,
  references,
  multiline = false,
  placeholder,
  disabled,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  references: ReferenceOption[]
  multiline?: boolean
  placeholder?: string
  disabled?: boolean
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ReferenceOption[]>()
    for (const option of references) map.set(option.group, [...(map.get(option.group) ?? []), option])
    return [...map.entries()]
  }, [references])
  return (
    <div className="flex flex-col gap-1">
      {multiline ? (
        <Textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={5} placeholder={placeholder} disabled={disabled} />
      ) : (
        <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} />
      )}
      {!disabled && references.length ? (
        <select
          aria-label="Insert data from the run or an earlier step"
          className={`${SELECT_CLASS} h-7 text-xs text-muted-foreground`}
          value=""
          onChange={(event) => {
            if (event.target.value) onChange(`${value}${value && !value.endsWith(' ') && !multiline ? ' ' : ''}${event.target.value}`)
          }}
        >
          <option value="">Insert data…</option>
          {groups.map(([group, options]) => (
            <optgroup key={group} label={group}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      ) : null}
    </div>
  )
}

function NumberInput({ id, value, onChange, min, max, disabled }: { id: string; value: number; onChange: (value: number) => void; min: number; max: number; disabled?: boolean }) {
  return <Input id={id} type="number" inputMode="numeric" min={min} max={max} value={Number.isFinite(value) ? value : ''} onChange={(event) => onChange(Number(event.target.value))} disabled={disabled} />
}

/** Where each of the step's paths leads (more than one target on a path runs them in parallel). */
function ConnectionsEditor({
  node,
  definition,
  disabled,
  onConnect,
  onDisconnect,
}: {
  node: WorkflowNode
  definition: WorkflowDefinition
  disabled?: boolean
  onConnect: (edge: { source: string; target: string; branch?: Branch }) => void
  onDisconnect: (edgeId: string) => void
}) {
  const branches = NODE_TYPE_INFO[node.type].branches
  if (!branches.length) return <p className="text-sm text-muted-foreground">An end step finishes its path; nothing follows it.</p>
  const label = (id: string) => definition.nodes.find((item) => item.id === id)?.label || id
  const targets = definition.nodes.filter((item) => item.id !== node.id && item.type !== 'trigger')
  return (
    <div className="flex flex-col gap-3">
      {branches.map((branch) => {
        const edges = definition.edges.filter((edge) => edge.source === node.id && (edge.branch ?? '') === branch)
        return (
          <div key={branch || 'then'} className="flex flex-col gap-1">
            <span className="text-sm font-medium">{branch ? BRANCH_LABELS[branch as Branch] : 'Then'}</span>
            {edges.map((edge) => (
              <div key={edge.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm">
                <span className="truncate">→ {label(edge.target)}</span>
                {!disabled ? (
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => onDisconnect(edge.id)} aria-label={`Remove the connection to ${label(edge.target)}`}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ))}
            {!disabled ? (
              <select
                aria-label={`Add a step to the ${branch || 'then'} path`}
                className={`${SELECT_CLASS} h-8`}
                value=""
                onChange={(event) => {
                  if (event.target.value) onConnect({ source: node.id, target: event.target.value, ...(branch ? { branch: branch as Branch } : {}) })
                }}
              >
                <option value="">{edges.length ? 'Also go to… (runs in parallel)' : 'Go to…'}</option>
                {targets
                  .filter((target) => !edges.some((edge) => edge.target === target.id))
                  .map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.label || target.id}
                    </option>
                  ))}
              </select>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function StepForm({
  node,
  definition,
  context,
  issues,
  readOnly = false,
  onChange,
  onRename,
  onDelete,
  onConnect,
  onDisconnect,
}: {
  node: WorkflowNode
  definition: WorkflowDefinition
  context: BuilderContext
  issues: ValidationIssue[]
  readOnly?: boolean
  onChange: (node: WorkflowNode) => void
  onRename: (from: string, to: string) => void
  onDelete: (id: string) => void
  onConnect: (edge: { source: string; target: string; branch?: Branch }) => void
  onDisconnect: (edgeId: string) => void
}) {
  const [idDraft, setIdDraft] = useState(node.id)
  const [idError, setIdError] = useState<string | null>(null)
  const references = useMemo(() => referencesAvailableTo(definition, node.id, context), [definition, node.id, context])
  const prefix = `step-${node.id}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setConfig = (patch: Record<string, any>) => onChange({ ...node, config: { ...node.config, ...patch } } as WorkflowNode)

  const commitId = () => {
    const next = idDraft.trim()
    if (next === node.id) return setIdError(null)
    if (!NODE_ID_PATTERN.test(next)) return setIdError('Use letters, numbers, - and _, starting with a letter.')
    if (definition.nodes.some((item) => item.id === next)) return setIdError('Another step already has that id.')
    setIdError(null)
    onRename(node.id, next)
  }

  return (
    <div className="flex flex-col gap-4">
      {issues.length ? (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Problems with this step">
          {issues.map((issue, position) => (
            <li key={position} className={issue.severity === 'error' ? 'text-destructive' : 'text-warning-foreground'}>
              {issue.severity === 'error' ? 'Problem: ' : 'Warning: '}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${prefix}-label`}>Name</FieldLabel>
          <Input id={`${prefix}-label`} value={node.label} maxLength={80} onChange={(event) => onChange({ ...node, label: event.target.value })} disabled={readOnly} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-id`}>Step id</FieldLabel>
          <Input id={`${prefix}-id`} value={idDraft} onChange={(event) => setIdDraft(event.target.value)} onBlur={commitId} disabled={readOnly} aria-invalid={idError ? true : undefined} />
          <FieldDescription>{idError ?? 'Used in references like {{steps.id.output.field}}.'}</FieldDescription>
        </Field>
      </div>

      {node.type === 'trigger' ? (
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={`${prefix}-kind`}>Starts</FieldLabel>
            <select id={`${prefix}-kind`} className={SELECT_CLASS} value={node.config.kind} disabled={readOnly} onChange={(event) => setConfig({ kind: event.target.value, ...(event.target.value === 'schedule' && !node.config.cron ? { cron: '0 9 * * 1-5', timezone: 'UTC' } : {}) })}>
              <option value="manual">By hand (Run button), with the inputs below</option>
              <option value="schedule">On a schedule</option>
            </select>
            <FieldDescription>Starting from another app’s events isn’t available yet.</FieldDescription>
          </Field>
          {node.config.kind === 'schedule' ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${prefix}-preset`}>Common schedules</FieldLabel>
                <select id={`${prefix}-preset`} className={SELECT_CLASS} value="" disabled={readOnly} onChange={(event) => event.target.value && setConfig({ cron: event.target.value })}>
                  <option value="">Choose…</option>
                  {SCHEDULE_PRESETS.map((preset) => (
                    <option key={preset.cron} value={preset.cron}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${prefix}-cron`}>Cron expression</FieldLabel>
                  <Input id={`${prefix}-cron`} value={node.config.cron} onChange={(event) => setConfig({ cron: event.target.value })} disabled={readOnly} placeholder="0 9 * * 1-5" />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${prefix}-tz`}>Time zone</FieldLabel>
                  <Input id={`${prefix}-tz`} value={node.config.timezone} onChange={(event) => setConfig({ timezone: event.target.value })} disabled={readOnly} placeholder="Europe/Paris" />
                </Field>
              </div>
              <p className="text-sm text-muted-foreground">
                {(() => {
                  const checked = checkSchedule(node.config.cron, node.config.timezone, new Date())
                  return checked.ok ? `Next run: ${checked.next.toLocaleString()}` : checked.message
                })()}
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      {node.type === 'employee_task' ? (
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={`${prefix}-employee`}>Employee</FieldLabel>
            <select id={`${prefix}-employee`} className={SELECT_CLASS} value={node.config.employeeId} disabled={readOnly} onChange={(event) => setConfig({ employeeId: event.target.value })}>
              <option value="">Choose an employee…</option>
              {context.employees.map((employee) => (
                <option key={employee.id} value={employee.id} disabled={employee.status !== 'active'}>
                  {employee.name}
                  {employee.status !== 'active' ? ` (${employee.status})` : employee.activeVersion ? ` (v${employee.activeVersion})` : ''}
                </option>
              ))}
            </select>
            <FieldDescription>The employee works with its own granted tools and approval rules; the version active when this workflow is activated is the one it runs.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-instructions`}>Instructions</FieldLabel>
            <TemplateInput id={`${prefix}-instructions`} value={node.config.instructions} onChange={(value) => setConfig({ instructions: value })} references={references} multiline disabled={readOnly} />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Values to report (outputs)</span>
            <p className="text-xs text-muted-foreground">The employee must fill these in when it finishes; later steps can use them.</p>
            {node.config.outputs.map((output, position) => (
              <div key={position} className="grid grid-cols-[1fr_2fr_auto] gap-2">
                <Input aria-label="Output name" value={output.key} disabled={readOnly} onChange={(event) => setConfig({ outputs: node.config.outputs.map((item, index) => (index === position ? { ...item, key: event.target.value } : item)) })} />
                <Input aria-label="What it means" value={output.description} disabled={readOnly} onChange={(event) => setConfig({ outputs: node.config.outputs.map((item, index) => (index === position ? { ...item, description: event.target.value } : item)) })} />
                {!readOnly ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove this output" onClick={() => setConfig({ outputs: node.config.outputs.filter((_, index) => index !== position) })}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ))}
            {!readOnly ? (
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setConfig({ outputs: [...node.config.outputs, { key: `value_${node.config.outputs.length + 1}`, description: '' }] })}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                Add an output
              </Button>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${prefix}-timeout`}>Deadline (minutes)</FieldLabel>
              <NumberInput id={`${prefix}-timeout`} value={node.config.timeoutMinutes} min={5} max={10080} onChange={(value) => setConfig({ timeoutMinutes: value })} disabled={readOnly} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-attempts`}>Attempts</FieldLabel>
              <NumberInput id={`${prefix}-attempts`} value={node.config.retry.maxAttempts} min={1} max={5} onChange={(value) => setConfig({ retry: { ...node.config.retry, maxAttempts: value } })} disabled={readOnly} />
              <FieldDescription>Temporary failures are retried from the employee’s last checkpoint.</FieldDescription>
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={node.config.requireVerified} disabled={readOnly} onCheckedChange={(checked) => setConfig({ requireVerified: checked === true })} />
            <span>Completion requires a verified, fully completed result (otherwise the step fails and takes its failure path).</span>
          </label>
        </div>
      ) : null}

      {node.type === 'tool_action'
        ? (() => {
            const tool = context.tools.find((item) => item.key === node.config.toolKey)
            const connections = tool ? context.connections.filter((connection) => connection.provider === tool.provider) : []
            const providers = [...new Set(context.tools.map((item) => item.providerName))]
            return (
              <div className="flex flex-col gap-3">
                <Field>
                  <FieldLabel htmlFor={`${prefix}-tool`}>Action</FieldLabel>
                  <select
                    id={`${prefix}-tool`}
                    className={SELECT_CLASS}
                    value={node.config.toolKey}
                    disabled={readOnly}
                    onChange={(event) => {
                      const next = context.tools.find((item) => item.key === event.target.value)
                      const candidates = next ? context.connections.filter((connection) => connection.provider === next.provider && connection.status === 'connected') : []
                      setConfig({
                        toolKey: event.target.value,
                        integrationId: candidates.length === 1 ? candidates[0]!.id : '',
                        input: next ? next.fields.filter((field) => field.required).map((field) => ({ field: field.name, value: '' })) : [],
                      })
                    }}
                  >
                    <option value="">Choose an action…</option>
                    {providers.map((provider) => (
                      <optgroup key={provider} label={provider}>
                        {context.tools
                          .filter((item) => item.providerName === provider)
                          .map((item) => (
                            <option key={item.key} value={item.key}>
                              {item.title}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  {tool ? <FieldDescription>{RISK_TEXT[tool.risk]}. {tool.approval === 'none' ? 'The connection’s setting decides whether it needs approval.' : 'Needs approval of the exact payload unless the connection allows it.'}</FieldDescription> : null}
                </Field>
                {tool ? (
                  <Field>
                    <FieldLabel htmlFor={`${prefix}-connection`}>Connection</FieldLabel>
                    <select id={`${prefix}-connection`} className={SELECT_CLASS} value={node.config.integrationId} disabled={readOnly} onChange={(event) => setConfig({ integrationId: event.target.value })}>
                      <option value="">Choose a {tool.providerName} connection…</option>
                      {connections.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.label}
                          {connection.status !== 'connected' ? ` (${connection.status})` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                {tool ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">Input fields</span>
                    {tool.fields.map((field) => {
                      const mapping = node.config.input.find((item) => item.field === field.name)
                      const update = (value: string) =>
                        setConfig({
                          input: mapping ? node.config.input.map((item) => (item.field === field.name ? { ...item, value } : item)) : [...node.config.input, { field: field.name, value }],
                        })
                      return (
                        <Field key={field.name}>
                          <FieldLabel htmlFor={`${prefix}-field-${field.name}`}>
                            {field.name}
                            {field.required ? ' (required)' : ''}
                          </FieldLabel>
                          <TemplateInput id={`${prefix}-field-${field.name}`} value={mapping?.value ?? ''} onChange={update} references={references} disabled={readOnly} placeholder={field.type} />
                          {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
                        </Field>
                      )
                    })}
                    <p className="text-xs text-muted-foreground">Empty fields are left out. A field that is exactly one reference keeps its type.</p>
                  </div>
                ) : null}
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={node.config.requireApproval} disabled={readOnly} onCheckedChange={(checked) => setConfig({ requireApproval: checked === true })} />
                  <span>Always ask for approval of the exact payload, even if the connection allows this action without review.</span>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={`${prefix}-attempts`}>Attempts</FieldLabel>
                    <NumberInput id={`${prefix}-attempts`} value={node.config.retry.maxAttempts} min={1} max={5} onChange={(value) => setConfig({ retry: { ...node.config.retry, maxAttempts: value } })} disabled={readOnly} />
                    <FieldDescription>Only temporary failures (rate limits, timeouts, outages) are retried, and only when repeating is safe.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${prefix}-backoff`}>Wait between attempts (seconds)</FieldLabel>
                    <NumberInput id={`${prefix}-backoff`} value={node.config.retry.backoffSeconds} min={0} max={3600} onChange={(value) => setConfig({ retry: { ...node.config.retry, backoffSeconds: value } })} disabled={readOnly} />
                  </Field>
                </div>
              </div>
            )
          })()
        : null}

      {node.type === 'condition' ? (
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={`${prefix}-match`}>True when</FieldLabel>
            <select id={`${prefix}-match`} className={SELECT_CLASS} value={node.config.match} disabled={readOnly} onChange={(event) => setConfig({ match: event.target.value })}>
              <option value="all">All rules match</option>
              <option value="any">Any rule matches</option>
            </select>
          </Field>
          {node.config.rules.map((rule, position) => {
            const update = (patch: Partial<typeof rule>) => setConfig({ rules: node.config.rules.map((item, index) => (index === position ? { ...item, ...patch } : item)) })
            return (
              <div key={position} className="flex flex-col gap-2 rounded-md border p-2">
                <TemplateInput id={`${prefix}-rule-${position}-left`} value={rule.left} onChange={(value) => update({ left: value })} references={references} placeholder="Value to test" disabled={readOnly} />
                <select aria-label="Comparison" className={SELECT_CLASS} value={rule.operator} disabled={readOnly} onChange={(event) => update({ operator: event.target.value as typeof rule.operator })}>
                  {CONDITION_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_LABELS[operator]}
                    </option>
                  ))}
                </select>
                {!UNARY_OPERATORS.includes(rule.operator) ? (
                  <TemplateInput id={`${prefix}-rule-${position}-right`} value={rule.right} onChange={(value) => update({ right: value })} references={references} placeholder="Compare with" disabled={readOnly} />
                ) : null}
                {!readOnly && node.config.rules.length > 1 ? (
                  <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setConfig({ rules: node.config.rules.filter((_, index) => index !== position) })}>
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    Remove rule
                  </Button>
                ) : null}
              </div>
            )
          })}
          {!readOnly ? (
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setConfig({ rules: [...node.config.rules, { left: '', operator: 'equals', right: '' }] })}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add a rule
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">Comparisons ignore case and surrounding spaces; numbers compare as numbers. No code is run.</p>
        </div>
      ) : null}

      {node.type === 'approval' ? (
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={`${prefix}-message`}>What the approver is asked</FieldLabel>
            <TemplateInput id={`${prefix}-message`} value={node.config.message} onChange={(value) => setConfig({ message: value })} references={references} multiline disabled={readOnly} />
            <FieldDescription>The approver sees this text with the data filled in, and approves exactly that.</FieldDescription>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${prefix}-role`}>Who can approve</FieldLabel>
              <select id={`${prefix}-role`} className={SELECT_CLASS} value={node.config.approverRole} disabled={readOnly} onChange={(event) => setConfig({ approverRole: event.target.value })}>
                {APPROVER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role[0]!.toUpperCase() + role.slice(1)} or above
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-expiry`}>Expires after (hours)</FieldLabel>
              <NumberInput id={`${prefix}-expiry`} value={node.config.expiresInHours} min={1} max={168} onChange={(value) => setConfig({ expiresInHours: value })} disabled={readOnly} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">An expired approval follows the “rejected or expired” path; without one, the run ends as rejected.</p>
        </div>
      ) : null}

      {node.type === 'transform' ? (
        <div className="flex flex-col gap-2">
          {node.config.fields.map((field, position) => {
            const update = (patch: Partial<typeof field>) => setConfig({ fields: node.config.fields.map((item, index) => (index === position ? { ...item, ...patch } : item)) })
            return (
              <div key={position} className="flex flex-col gap-2 rounded-md border p-2">
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <Input aria-label="Field name" value={field.key} disabled={readOnly} onChange={(event) => update({ key: event.target.value })} />
                  <select aria-label="Format" className={SELECT_CLASS} value={field.format} disabled={readOnly} onChange={(event) => update({ format: event.target.value as typeof field.format })}>
                    {TRANSFORM_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {FORMAT_LABELS[format]}
                      </option>
                    ))}
                  </select>
                  {!readOnly ? (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove this field" onClick={() => setConfig({ fields: node.config.fields.filter((_, index) => index !== position) })}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
                <TemplateInput id={`${prefix}-field-${position}`} value={field.value} onChange={(value) => update({ value })} references={references} placeholder="Value, e.g. {{inputs.email}}" disabled={readOnly} />
              </div>
            )
          })}
          {!readOnly ? (
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setConfig({ fields: [...node.config.fields, { key: `field_${node.config.fields.length + 1}`, value: '', format: 'text' }] })}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add a field
            </Button>
          ) : null}
        </div>
      ) : null}

      {node.type === 'delay' ? (
        <Field>
          <FieldLabel htmlFor={`${prefix}-minutes`}>Wait (minutes)</FieldLabel>
          <NumberInput id={`${prefix}-minutes`} value={node.config.minutes} min={1} max={10080} onChange={(value) => setConfig({ minutes: value })} disabled={readOnly} />
          <FieldDescription>The run waits as a saved state; nothing runs meanwhile.</FieldDescription>
        </Field>
      ) : null}

      {node.type === 'end' ? (
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={`${prefix}-status`}>The run ends as</FieldLabel>
            <select id={`${prefix}-status`} className={SELECT_CLASS} value={node.config.status} disabled={readOnly} onChange={(event) => setConfig({ status: event.target.value })}>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-summary`}>Result summary</FieldLabel>
            <TemplateInput id={`${prefix}-summary`} value={node.config.summary} onChange={(value) => setConfig({ summary: value })} references={references} multiline disabled={readOnly} />
          </Field>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="text-sm font-medium">Connections</span>
        <ConnectionsEditor node={node} definition={definition} disabled={readOnly} onConnect={onConnect} onDisconnect={onDisconnect} />
      </div>

      {!readOnly ? (
        <Button type="button" variant="destructive" size="sm" className="self-start" onClick={() => onDelete(node.id)}>
          <Trash2 data-icon="inline-start" aria-hidden="true" />
          Remove this step
        </Button>
      ) : null}
    </div>
  )
}

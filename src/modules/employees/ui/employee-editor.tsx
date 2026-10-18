'use client'

// The employee configuration form: every field an employee is reviewed on.
// The whole draft is sent as JSON and validated again on the server (schema,
// then tools/connections/sources), so nothing here is trusted.

import { CircleAlert, Save, TriangleAlert } from 'lucide-react'
import { useActionState, useMemo, useState } from 'react'

import { SectionCard } from '@/components/cards'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { EFFORT_LABELS, MODELS, TIER_LABELS } from '@/modules/models/domain/catalog'

import { defaultGrant } from '../domain/defaults'
import {
  CONFIG_BOUNDS,
  DEPARTMENT_LABELS,
  DEPARTMENTS,
  ESCALATION_BEHAVIOR_LABELS,
  ESCALATION_BEHAVIORS,
  MODEL_EFFORTS,
  MODEL_TIERS,
  type ConnectionOption,
  type EmployeeConfig,
  type EmployeeDraft,
  type EmployeeToolGrant,
  type EmployeeToolInfo,
  type KnowledgeSourceOption,
  type SkillOption,
} from '../domain/types'
import { saveEmployeeAction, type SaveState } from '../server/actions'
import { fromLines, RISK_TEXT, SELECT_CLASS, toLines } from './labels'

const IDLE: SaveState = { status: 'idle' }

type ListField = 'responsibilities' | 'successCriteria' | 'allowedActions' | 'prohibitedActions' | 'escalationWhen'

function initialLists(config: EmployeeConfig): Record<ListField, string> {
  return {
    responsibilities: toLines(config.responsibilities),
    successCriteria: toLines(config.successCriteria),
    allowedActions: toLines(config.allowedActions),
    prohibitedActions: toLines(config.prohibitedActions),
    escalationWhen: toLines(config.escalation.when),
  }
}

function numberValue(text: string): number {
  const value = Number(text)
  return Number.isFinite(value) ? value : 0
}

export function EmployeeEditor({
  organizationId,
  employeeId,
  basedOnVersionId,
  initial,
  tools,
  connections,
  sources,
  skills,
  submitLabel,
}: {
  organizationId: string
  employeeId?: string
  basedOnVersionId?: string
  initial: EmployeeDraft
  tools: EmployeeToolInfo[]
  connections: ConnectionOption[]
  sources: KnowledgeSourceOption[]
  skills: SkillOption[]
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(saveEmployeeAction, IDLE)
  const [config, setConfig] = useState<EmployeeConfig>(initial.config)
  const [instructions, setInstructions] = useState(initial.instructions)
  const [lists, setLists] = useState(() => initialLists(initial.config))
  const [numbers, setNumbers] = useState(() => ({
    maxTurnsPerTask: String(initial.config.limits.maxTurnsPerTask),
    maxToolCallsPerTask: String(initial.config.limits.maxToolCallsPerTask),
    maxCostUsdPerTask: String(initial.config.limits.maxCostUsdPerTask),
    maxRuntimeSeconds: String(initial.config.limits.maxRuntimeSeconds),
    monthlyUsd: String(initial.config.budget.monthlyUsd),
    maxPassages: String(initial.config.knowledge.maxPassages),
    maxOutputTokens: String(initial.config.model.maxOutputTokens),
  }))
  const [changeNote, setChangeNote] = useState('')

  const draft: EmployeeDraft = useMemo(
    () => ({
      instructions,
      config: {
        ...config,
        responsibilities: fromLines(lists.responsibilities),
        successCriteria: fromLines(lists.successCriteria),
        allowedActions: fromLines(lists.allowedActions),
        prohibitedActions: fromLines(lists.prohibitedActions),
        escalation: { ...config.escalation, when: fromLines(lists.escalationWhen) },
        knowledge: { ...config.knowledge, maxPassages: numberValue(numbers.maxPassages) },
        model: { ...config.model, maxOutputTokens: numberValue(numbers.maxOutputTokens) },
        limits: {
          maxTurnsPerTask: numberValue(numbers.maxTurnsPerTask),
          maxToolCallsPerTask: numberValue(numbers.maxToolCallsPerTask),
          maxCostUsdPerTask: numberValue(numbers.maxCostUsdPerTask),
          maxRuntimeSeconds: numberValue(numbers.maxRuntimeSeconds),
        },
        budget: { monthlyUsd: numberValue(numbers.monthlyUsd) },
      },
    }),
    [config, instructions, lists, numbers],
  )

  const update = <K extends keyof EmployeeConfig>(key: K, value: EmployeeConfig[K]) => setConfig((current) => ({ ...current, [key]: value }))
  const grantFor = (key: string) => config.tools.find((grant) => grant.toolKey === key)
  const setGrant = (key: string, grant: EmployeeToolGrant | null) =>
    update('tools', grant ? [...config.tools.filter((item) => item.toolKey !== key), grant] : config.tools.filter((item) => item.toolKey !== key))

  const issues = state.status === 'error' ? (state.issues ?? []) : []
  const approvalTools = draft.config.tools.filter((grant) => {
    const tool = tools.find((candidate) => candidate.key === grant.toolKey)
    return grant.approval === 'require_approval' || (tool && tool.approvalRequirement !== 'none')
  })

  const listField = (field: ListField, label: string, description: string, rows = 4) => (
    <Field>
      <FieldLabel htmlFor={`employee-${field}`}>{label}</FieldLabel>
      <Textarea
        id={`employee-${field}`}
        rows={rows}
        value={lists[field]}
        onChange={(event) => setLists((current) => ({ ...current, [field]: event.target.value }))}
      />
      <FieldDescription>{description} One per line.</FieldDescription>
    </Field>
  )

  const numberField = (key: keyof typeof numbers, label: string, bounds: { min: number; max: number }, step = 1, description?: string) => (
    <Field>
      <FieldLabel htmlFor={`employee-${key}`}>{label}</FieldLabel>
      <Input
        id={`employee-${key}`}
        type="number"
        inputMode="decimal"
        min={bounds.min}
        max={bounds.max}
        step={step}
        value={numbers[key]}
        onChange={(event) => setNumbers((current) => ({ ...current, [key]: event.target.value }))}
      />
      <FieldDescription>
        {description ? `${description} ` : ''}
        {bounds.min}–{bounds.max}.
      </FieldDescription>
    </Field>
  )

  return (
    <form action={formAction} className="flex flex-col gap-6" aria-label="Employee configuration">
      <input type="hidden" name="organizationId" value={organizationId} />
      {employeeId ? <input type="hidden" name="employeeId" value={employeeId} /> : null}
      {basedOnVersionId ? <input type="hidden" name="basedOnVersionId" value={basedOnVersionId} /> : null}
      <input type="hidden" name="draft" value={JSON.stringify(draft)} />

      <SectionCard title="Profile">
        <div className="grid gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="employee-name">Name</FieldLabel>
            <Input
              id="employee-name"
              required
              maxLength={CONFIG_BOUNDS.name}
              value={config.profile.name}
              onChange={(event) => update('profile', { ...config.profile, name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="employee-department">Department</FieldLabel>
            <select
              id="employee-department"
              className={SELECT_CLASS}
              value={config.profile.department}
              onChange={(event) => update('profile', { ...config.profile, department: event.target.value as EmployeeConfig['profile']['department'] })}
            >
              {DEPARTMENTS.map((department) => (
                <option key={department} value={department}>
                  {DEPARTMENT_LABELS[department]}
                </option>
              ))}
            </select>
            <FieldDescription>Every department runs on the same runtime; this only labels and groups the employee.</FieldDescription>
          </Field>
          <Field className="md:col-span-2">
            <FieldLabel htmlFor="employee-description">Description</FieldLabel>
            <Textarea
              id="employee-description"
              rows={2}
              maxLength={CONFIG_BOUNDS.description}
              value={config.profile.description}
              onChange={(event) => update('profile', { ...config.profile, description: event.target.value })}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Responsibilities and instructions">
        <div className="flex flex-col gap-4">
          {listField('responsibilities', 'Responsibilities', 'What this employee is responsible for.')}
          <Field>
            <FieldLabel htmlFor="employee-instructions">Instructions</FieldLabel>
            <Textarea
              id="employee-instructions"
              rows={8}
              maxLength={CONFIG_BOUNDS.instructions}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
            <FieldDescription>How it should work, in your words. Platform safety rules always come first and can’t be overridden here.</FieldDescription>
          </Field>
          {listField('successCriteria', 'Success criteria', 'What a good result looks like. Use them to write test cases.', 3)}
        </div>
      </SectionCard>

      <SectionCard
        title="Tools and approval rules"
        description="Only tools that exist are listed. The employee can use exactly the tools granted here. An approval can be added here but never removed: connection settings and workspace policies still apply."
      >
        <ul className="flex flex-col divide-y">
          {tools.map((tool) => {
            const grant = grantFor(tool.key)
            const options = connections.filter((connection) => connection.provider === tool.provider)
            const alwaysApproval = tool.approvalRequirement !== 'none'
            return (
              <li key={tool.key} className="flex flex-col gap-3 py-3 md:flex-row md:items-start">
                <div className="flex flex-1 items-start gap-3">
                  <Checkbox
                    id={`tool-${tool.key}`}
                    checked={Boolean(grant)}
                    onCheckedChange={(checked) => {
                      const candidates = options.filter((connection) => connection.status === 'connected')
                      setGrant(tool.key, checked ? defaultGrant(tool, tool.needsConnection && candidates.length === 1 ? candidates[0]!.id : null) : null)
                    }}
                    className="mt-0.5"
                  />
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`tool-${tool.key}`} className="text-sm font-medium">
                      {tool.title}
                    </label>
                    <p className="text-sm text-muted-foreground">{tool.description}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline">{RISK_TEXT[tool.risk]}</Badge>
                      {alwaysApproval ? <Badge variant="outline">Needs approval by default</Badge> : null}
                      <code className="text-xs text-muted-foreground">{tool.key}</code>
                    </div>
                  </div>
                </div>
                {grant ? (
                  <div className="grid w-full gap-2 md:w-80">
                    {tool.needsConnection ? (
                      <Field>
                        <FieldLabel htmlFor={`connection-${tool.key}`} className="text-xs">
                          {tool.providerName} connection
                        </FieldLabel>
                        <select
                          id={`connection-${tool.key}`}
                          className={SELECT_CLASS}
                          value={grant.integrationId ?? ''}
                          onChange={(event) => setGrant(tool.key, { ...grant, integrationId: event.target.value || null })}
                        >
                          <option value="">{options.length ? 'Choose a connection' : `No ${tool.providerName} connection yet`}</option>
                          {options.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                              {connection.label}
                              {connection.status === 'connected' ? '' : ` (${connection.status.replace('_', ' ')})`}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
                    <Field>
                      <FieldLabel htmlFor={`approval-${tool.key}`} className="text-xs">
                        Approval
                      </FieldLabel>
                      <select
                        id={`approval-${tool.key}`}
                        className={SELECT_CLASS}
                        value={grant.approval}
                        onChange={(event) => setGrant(tool.key, { ...grant, approval: event.target.value as EmployeeToolGrant['approval'] })}
                      >
                        <option value="require_approval">Always ask for approval</option>
                        <option value="allow">{alwaysApproval ? 'Follow the connection setting' : 'Run without asking'}</option>
                      </select>
                    </Field>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
        <div className="mt-4 rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="font-medium">Approval rules for this employee</p>
          {approvalTools.length ? (
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {approvalTools.map((grant) => (
                <li key={grant.toolKey}>{tools.find((tool) => tool.key === grant.toolKey)?.title ?? grant.toolKey}: waits for an approver before it runs.</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No granted tool needs approval. Workspace policies can still require it.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Skills and knowledge access">
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Skills</legend>
            {skills.map((skill) => {
              const checked = config.skills.includes(skill.key)
              return (
                <div key={skill.key} className="flex items-start gap-3">
                  <Checkbox
                    id={`skill-${skill.key}`}
                    checked={checked}
                    onCheckedChange={(value) => update('skills', value ? [...config.skills, skill.key] : config.skills.filter((key) => key !== skill.key))}
                    className="mt-0.5"
                  />
                  <label htmlFor={`skill-${skill.key}`} className="text-sm">
                    <span className="font-medium">{skill.name}</span>
                    {skill.description ? <span className="text-muted-foreground"> — {skill.description}</span> : null}
                    {skill.toolKeys.some((key) => !grantFor(key)) ? (
                      <span className="block text-xs text-muted-foreground">Uses: {skill.toolKeys.join(', ')}. Grant those tools above for the skill to work.</span>
                    ) : null}
                  </label>
                </div>
              )
            })}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Knowledge access</legend>
            {(
              [
                ['none', 'No knowledge access'],
                ['all', 'All documents and business context'],
                ['selected', 'Only selected documents'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="knowledge-access-choice"
                  value={value}
                  checked={config.knowledge.access === value}
                  onChange={() => update('knowledge', { ...config.knowledge, access: value })}
                  className="accent-primary"
                />
                {label}
              </label>
            ))}
            {config.knowledge.access === 'selected' ? (
              <div className="ml-6 flex flex-col gap-1.5">
                {sources.length ? (
                  sources.map((source) => (
                    <label key={source.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={config.knowledge.sourceIds.includes(source.id)}
                        onCheckedChange={(value) =>
                          update('knowledge', {
                            ...config.knowledge,
                            sourceIds: value ? [...config.knowledge.sourceIds, source.id] : config.knowledge.sourceIds.filter((id) => id !== source.id),
                          })
                        }
                      />
                      {source.name} <span className="text-xs text-muted-foreground">({source.status})</span>
                    </label>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No documents uploaded yet. Add them under Knowledge.</p>
                )}
              </div>
            ) : null}
            <div className="max-w-xs">{numberField('maxPassages', 'Passages per search', CONFIG_BOUNDS.maxPassages)}</div>
          </fieldset>
        </div>
      </SectionCard>

      <SectionCard title="Model">
        <div className="grid gap-4 md:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="employee-tier">Model tier</FieldLabel>
            <select
              id="employee-tier"
              className={SELECT_CLASS}
              value={config.model.tier}
              onChange={(event) => update('model', { ...config.model, tier: event.target.value as EmployeeConfig['model']['tier'] })}
            >
              {MODEL_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {TIER_LABELS[tier].label} ({MODELS[tier].label})
                </option>
              ))}
            </select>
            <FieldDescription>{TIER_LABELS[config.model.tier].description}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="employee-effort">Effort</FieldLabel>
            <select
              id="employee-effort"
              className={SELECT_CLASS}
              value={config.model.effort}
              onChange={(event) => update('model', { ...config.model, effort: event.target.value as EmployeeConfig['model']['effort'] })}
            >
              {MODEL_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {EFFORT_LABELS[effort]}
                </option>
              ))}
            </select>
          </Field>
          {numberField('maxOutputTokens', 'Max output tokens per step', CONFIG_BOUNDS.maxOutputTokens, 256)}
        </div>
      </SectionCard>

      <SectionCard title="Allowed and prohibited actions">
        <div className="grid gap-4 md:grid-cols-2">
          {listField('allowedActions', 'Allowed actions', 'What it may do (tools still decide what it can do).')}
          {listField('prohibitedActions', 'Prohibited actions', 'What it must never do.')}
        </div>
      </SectionCard>

      <SectionCard title="Escalation">
        <div className="flex flex-col gap-4">
          {listField('escalationWhen', 'Escalate when', 'Situations where it stops instead of guessing.', 3)}
          <Field>
            <FieldLabel htmlFor="employee-escalation">When it escalates</FieldLabel>
            <select
              id="employee-escalation"
              className={SELECT_CLASS}
              value={config.escalation.behavior}
              onChange={(event) => update('escalation', { ...config.escalation, behavior: event.target.value as EmployeeConfig['escalation']['behavior'] })}
            >
              {ESCALATION_BEHAVIORS.map((behavior) => (
                <option key={behavior} value={behavior}>
                  {ESCALATION_BEHAVIOR_LABELS[behavior]}
                </option>
              ))}
            </select>
            <FieldDescription>The run stops and the reason is recorded. Notifying a person by email isn’t built yet.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="employee-escalation-notes">Escalation notes</FieldLabel>
            <Textarea
              id="employee-escalation-notes"
              rows={2}
              maxLength={CONFIG_BOUNDS.escalationNotes}
              value={config.escalation.notes}
              onChange={(event) => update('escalation', { ...config.escalation, notes: event.target.value })}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Execution limits and budget" description="The runtime stops a task before it crosses any of these.">
        <div className="grid gap-4 md:grid-cols-3">
          {numberField('maxTurnsPerTask', 'Max steps per task', CONFIG_BOUNDS.maxTurnsPerTask)}
          {numberField('maxToolCallsPerTask', 'Max tool calls per task', CONFIG_BOUNDS.maxToolCallsPerTask)}
          {numberField('maxRuntimeSeconds', 'Max seconds per task', CONFIG_BOUNDS.maxRuntimeSeconds)}
          {numberField('maxCostUsdPerTask', 'Max cost per task (USD)', CONFIG_BOUNDS.maxCostUsdPerTask, 0.01)}
          {numberField('monthlyUsd', 'Monthly budget (USD)', CONFIG_BOUNDS.monthlyUsd, 1, 'Test runs count toward it.')}
        </div>
      </SectionCard>

      <div className="flex flex-col gap-3">
        <Field className="max-w-xl">
          <FieldLabel htmlFor="employee-change-note">What changed (optional)</FieldLabel>
          <Input id="employee-change-note" name="changeNote" maxLength={1000} value={changeNote} onChange={(event) => setChangeNote(event.target.value)} />
          <FieldDescription>Saved with the version so its history explains itself.</FieldDescription>
        </Field>
        <div aria-live="polite">
          {state.status === 'error' ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{state.message}</AlertTitle>
              {issues.length ? (
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {issues.map((issue) => (
                      <li key={`${issue.path}:${issue.message}`}>
                        {issue.path ? <code className="text-xs">{issue.path}</code> : null} {issue.message}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              ) : null}
            </Alert>
          ) : null}
        </div>
        {draft.config.tools.some((grant) => tools.find((tool) => tool.key === grant.toolKey)?.needsConnection && !grant.integrationId) ? (
          <Alert>
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>Some tools have no connection chosen. You can save, but they won’t work in tests, and the employee can’t be activated until they do.</AlertDescription>
          </Alert>
        ) : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Save data-icon="inline-start" aria-hidden="true" />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  )
}

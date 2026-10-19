'use client'

// Edits one workspace policy (document version 2): rules (allow, require
// approval, deny — by action, category, risk tier, employee and actor, with
// approval settings), approval defaults, a tool allowlist for AI work,
// data-access restrictions and limits. The server validates it again
// (governance/domain/schemas.ts) and so does the database; saving records a
// new revision authorized by the person who saved it.

import { Plus, Save, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { ActionState } from '@/lib/forms/action-state'

import type { PolicyDocument, PolicyRule } from '../domain/policy'
import { POLICY_ACTORS } from '../domain/policy'
import { ACTION_CATEGORIES, ACTION_CATEGORY_INFO, RISK_TIER_INFO, RISK_TIERS } from '../domain/risk'
import { deletePolicy, savePolicy } from '../server/actions'

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 dark:bg-input/30'

const EFFECT_LABELS: Record<PolicyRule['effect'], string> = { allow: 'Allow without approval', require_approval: 'Require approval', deny: 'Block' }
const ACTOR_LABELS: Record<(typeof POLICY_ACTORS)[number], string> = { employee: 'AI employees', workflow: 'Workflow steps', person: 'People' }

interface RuleDraft {
  key: number
  description: string
  effect: PolicyRule['effect']
  toolKeys: string
  categories: string[]
  tiers: string[]
  actors: string[]
  employeeIds: string[]
  approverRole: string
  separateApprover: boolean
  hours: string
}

export interface PolicyEditorValue {
  id: string | null
  name: string
  description: string
  enabled: boolean
  priority: number
  document: PolicyDocument
}

export interface PolicyEditorOptions {
  tools: readonly { key: string; title: string; category: string }[]
  employees: readonly { id: string; name: string }[]
  sources: readonly { id: string; name: string }[]
}

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
const numberOrUndefined = (text: string) => (text.trim() === '' ? undefined : Number(text))

function toDraft(rule: PolicyRule, key: number): RuleDraft {
  return {
    key,
    description: rule.description ?? '',
    effect: rule.effect,
    toolKeys: (rule.toolKeys ?? []).join('\n'),
    categories: rule.categories ?? [],
    tiers: rule.tiers ?? [],
    actors: rule.actors ?? [],
    employeeIds: rule.employeeIds ?? [],
    approverRole: rule.approverRole ?? '',
    separateApprover: rule.separateApprover ?? false,
    hours: rule.approvalExpiresInHours ? String(rule.approvalExpiresInHours) : '',
  }
}

function fromDraft(draft: RuleDraft, index: number): PolicyRule {
  const toolKeys = lines(draft.toolKeys)
  const approval = draft.effect === 'require_approval'
  return {
    id: `rule-${index + 1}`,
    effect: draft.effect,
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(toolKeys.length ? { toolKeys } : {}),
    ...(draft.categories.length ? { categories: draft.categories as PolicyRule['categories'] } : {}),
    ...(draft.tiers.length ? { tiers: draft.tiers as PolicyRule['tiers'] } : {}),
    ...(draft.actors.length ? { actors: draft.actors as PolicyRule['actors'] } : {}),
    ...(draft.employeeIds.length ? { employeeIds: draft.employeeIds } : {}),
    ...(approval && draft.approverRole ? { approverRole: draft.approverRole as PolicyRule['approverRole'] } : {}),
    ...(approval && draft.separateApprover ? { separateApprover: true } : {}),
    ...(approval && draft.hours.trim() ? { approvalExpiresInHours: Number(draft.hours) } : {}),
  }
}

function Choices({
  legend,
  options,
  selected,
  onChange,
  disabled,
  idPrefix,
}: {
  legend: string
  options: readonly { value: string; label: string }[]
  selected: string[]
  onChange: (next: string[]) => void
  disabled: boolean
  idPrefix: string
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((option) => {
          const id = `${idPrefix}-${option.value}`
          return (
            <div key={option.value} className="flex items-center gap-1.5">
              <Checkbox
                id={id}
                checked={selected.includes(option.value)}
                disabled={disabled}
                onCheckedChange={(checked) => onChange(checked ? [...selected, option.value] : selected.filter((value) => value !== option.value))}
              />
              <Label htmlFor={id} className="font-normal">
                {option.label}
              </Label>
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

export function PolicyEditor({
  organizationId,
  value,
  options,
  canManage,
}: {
  organizationId: string
  value: PolicyEditorValue
  options: PolicyEditorOptions
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionState | null>(null)
  const [name, setName] = useState(value.name)
  const [description, setDescription] = useState(value.description)
  const [enabled, setEnabled] = useState(value.enabled)
  const [priority, setPriority] = useState(String(value.priority))
  const [nextKey, setNextKey] = useState(value.document.rules.length)
  const [rules, setRules] = useState<RuleDraft[]>(value.document.rules.map(toDraft))
  const [approvalHours, setApprovalHours] = useState(String(value.document.approvals?.expiresInHours ?? value.document.defaults?.approvalExpiresInHours ?? ''))
  const [separateApprover, setSeparateApprover] = useState(value.document.approvals?.separateApprover ?? false)
  const [allowlistOn, setAllowlistOn] = useState(Array.isArray(value.document.tools?.allowlist))
  const [allowlist, setAllowlist] = useState((value.document.tools?.allowlist ?? []).join('\n'))
  const [blocked, setBlocked] = useState<string[]>(value.document.dataAccess?.blockedSourceIds ?? [])
  const [requireSelected, setRequireSelected] = useState(value.document.dataAccess?.requireSelectedSources ?? false)
  const [limits, setLimits] = useState({
    maxTaskRuntimeSeconds: String(value.document.limits?.maxTaskRuntimeSeconds ?? ''),
    maxCostUsdPerTask: String(value.document.limits?.maxCostUsdPerTask ?? ''),
    employeeMonthlyUsd: String(value.document.limits?.employeeMonthlyUsd ?? ''),
    organizationMonthlyUsd: String(value.document.limits?.organizationMonthlyUsd ?? ''),
  })
  const disabled = !canManage || pending

  const update = (key: number, patch: Partial<RuleDraft>) => setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)))
  const addRule = () => {
    setRules((current) => [...current, { key: nextKey, description: '', effect: 'require_approval', toolKeys: '', categories: [], tiers: [], actors: [], employeeIds: [], approverRole: '', separateApprover: false, hours: '' }])
    setNextKey((key) => key + 1)
  }

  const save = () =>
    startTransition(async () => {
      const limitValues = Object.fromEntries(Object.entries(limits).flatMap(([key, text]) => (numberOrUndefined(text) === undefined ? [] : [[key, Number(text)]])))
      const document: PolicyDocument = {
        rules: rules.map(fromDraft),
        ...(numberOrUndefined(approvalHours) !== undefined || separateApprover
          ? { approvals: { ...(numberOrUndefined(approvalHours) !== undefined ? { expiresInHours: Number(approvalHours) } : {}), ...(separateApprover ? { separateApprover: true } : {}) } }
          : {}),
        ...(allowlistOn ? { tools: { allowlist: lines(allowlist) } } : {}),
        ...(blocked.length || requireSelected ? { dataAccess: { ...(blocked.length ? { blockedSourceIds: blocked } : {}), ...(requireSelected ? { requireSelectedSources: true } : {}) } } : {}),
        ...(Object.keys(limitValues).length ? { limits: limitValues } : {}),
      }
      const outcome = await savePolicy({
        organizationId,
        policyId: value.id,
        settings: { name, description, enabled, priority: Number(priority) || 0 },
        document,
      })
      setResult(outcome)
      if (outcome.status === 'success') {
        if (!value.id && outcome.data?.id) router.push(`/app/settings/governance/policies/${outcome.data.id}`)
        else router.refresh()
      }
    })

  const toolOptions = options.tools.map((tool) => `${tool.key} — ${tool.title} (${RISK_TIER_INFO[ACTION_CATEGORY_INFO[tool.category as keyof typeof ACTION_CATEGORY_INFO]?.tier ?? 'low'].label} risk)`)

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 sm:grid-cols-[1fr_8rem]" aria-label="Policy">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-name">Name</Label>
          <Input id="policy-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} disabled={disabled} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-priority">Order</Label>
          <Input id="policy-priority" type="number" min={0} max={10000} value={priority} onChange={(event) => setPriority(event.target.value)} disabled={disabled} />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="policy-description">What it’s for (optional)</Label>
          <Textarea id="policy-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={2000} disabled={disabled} />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="policy-enabled" checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} disabled={disabled} />
          <Label htmlFor="policy-enabled" className="font-normal">
            On
          </Label>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="rules-heading">
        <div>
          <h3 id="rules-heading" className="font-medium">
            Rules
          </h3>
          <p className="text-sm text-muted-foreground">
            A rule applies when every field you fill in matches (empty means any). The strictest matching rule across all policies wins. “Allow without approval” must name
            exact actions and only counts when an admin (an owner, for critical actions) saved the policy.
          </p>
        </div>
        {rules.map((rule, index) => (
          <div key={rule.key} className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                <Label htmlFor={`rule-${rule.key}-effect`}>Rule {index + 1}</Label>
                <select
                  id={`rule-${rule.key}-effect`}
                  className={SELECT_CLASS}
                  value={rule.effect}
                  disabled={disabled}
                  onChange={(event) => update(rule.key, { effect: event.target.value as PolicyRule['effect'] })}
                >
                  {Object.entries(EFFECT_LABELS).map(([effect, label]) => (
                    <option key={effect} value={effect}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex min-w-48 flex-[2] flex-col gap-1.5">
                <Label htmlFor={`rule-${rule.key}-description`}>Description (optional)</Label>
                <Input id={`rule-${rule.key}-description`} value={rule.description} onChange={(event) => update(rule.key, { description: event.target.value })} maxLength={500} disabled={disabled} />
              </div>
              {canManage ? (
                <Button variant="ghost" size="sm" onClick={() => setRules((current) => current.filter((item) => item.key !== rule.key))} disabled={pending} aria-label={`Remove rule ${index + 1}`}>
                  <Trash2 aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`rule-${rule.key}-tools`}>Actions (one per line: an exact key, a provider such as hubspot.*, or *)</Label>
              <Textarea id={`rule-${rule.key}-tools`} value={rule.toolKeys} onChange={(event) => update(rule.key, { toolKeys: event.target.value })} rows={2} disabled={disabled} className="font-mono text-xs" />
            </div>
            <Choices
              legend="Categories"
              idPrefix={`rule-${rule.key}-category`}
              options={ACTION_CATEGORIES.map((category) => ({ value: category, label: ACTION_CATEGORY_INFO[category].label }))}
              selected={rule.categories}
              onChange={(categories) => update(rule.key, { categories })}
              disabled={disabled}
            />
            <Choices
              legend="Risk tiers"
              idPrefix={`rule-${rule.key}-tier`}
              options={RISK_TIERS.map((tier) => ({ value: tier, label: RISK_TIER_INFO[tier].label }))}
              selected={rule.tiers}
              onChange={(tiers) => update(rule.key, { tiers })}
              disabled={disabled}
            />
            <Choices
              legend="Who acts"
              idPrefix={`rule-${rule.key}-actor`}
              options={POLICY_ACTORS.map((actor) => ({ value: actor, label: ACTOR_LABELS[actor] }))}
              selected={rule.actors}
              onChange={(actors) => update(rule.key, { actors })}
              disabled={disabled}
            />
            {options.employees.length ? (
              <Choices
                legend="Only these employees"
                idPrefix={`rule-${rule.key}-employee`}
                options={options.employees.map((employee) => ({ value: employee.id, label: employee.name }))}
                selected={rule.employeeIds}
                onChange={(employeeIds) => update(rule.key, { employeeIds })}
                disabled={disabled}
              />
            ) : null}
            {rule.effect === 'require_approval' ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`rule-${rule.key}-role`}>Approver at least</Label>
                  <select id={`rule-${rule.key}-role`} className={SELECT_CLASS} value={rule.approverRole} disabled={disabled} onChange={(event) => update(rule.key, { approverRole: event.target.value })}>
                    <option value="">The tier’s default</option>
                    <option value="operator">Operator</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`rule-${rule.key}-hours`}>Approval valid for (hours)</Label>
                  <Input id={`rule-${rule.key}-hours`} type="number" min={1} max={720} value={rule.hours} onChange={(event) => update(rule.key, { hours: event.target.value })} disabled={disabled} placeholder="Default" />
                </div>
                <div className="flex items-center gap-2 sm:pt-6">
                  <Checkbox id={`rule-${rule.key}-separate`} checked={rule.separateApprover} onCheckedChange={(checked) => update(rule.key, { separateApprover: checked === true })} disabled={disabled} />
                  <Label htmlFor={`rule-${rule.key}-separate`} className="font-normal">
                    Not the requester
                  </Label>
                </div>
              </div>
            ) : null}
          </div>
        ))}
        {canManage ? (
          <div>
            <Button variant="outline" size="sm" onClick={addRule} disabled={pending}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add a rule
            </Button>
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 sm:grid-cols-2" aria-labelledby="approvals-heading">
        <h3 id="approvals-heading" className="font-medium sm:col-span-2">
          Approvals
        </h3>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="approval-hours">Approvals expire after (hours)</Label>
          <Input id="approval-hours" type="number" min={1} max={720} value={approvalHours} onChange={(event) => setApprovalHours(event.target.value)} disabled={disabled} placeholder="Tier default (24–72)" />
        </div>
        <div className="flex items-center gap-2 sm:pt-6">
          <Checkbox id="separate-approver" checked={separateApprover} onCheckedChange={(checked) => setSeparateApprover(checked === true)} disabled={disabled} />
          <Label htmlFor="separate-approver" className="font-normal">
            The requester can never approve their own request
          </Label>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="allowlist-heading">
        <h3 id="allowlist-heading" className="font-medium">
          Tool allowlist
        </h3>
        <div className="flex items-center gap-2">
          <Checkbox id="allowlist-on" checked={allowlistOn} onCheckedChange={(checked) => setAllowlistOn(checked === true)} disabled={disabled} />
          <Label htmlFor="allowlist-on" className="font-normal">
            AI employees and workflows may only use the tools listed here (people are not limited)
          </Label>
        </div>
        {allowlistOn ? (
          <>
            <Textarea aria-label="Allowed tools" value={allowlist} onChange={(event) => setAllowlist(event.target.value)} rows={4} disabled={disabled} className="font-mono text-xs" />
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">Tools in Nexefiy</summary>
              <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                {toolOptions.map((tool) => (
                  <li key={tool}>{tool}</li>
                ))}
              </ul>
            </details>
          </>
        ) : null}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="data-heading">
        <h3 id="data-heading" className="font-medium">
          Data access
        </h3>
        <div className="flex items-center gap-2">
          <Checkbox id="require-selected" checked={requireSelected} onCheckedChange={(checked) => setRequireSelected(checked === true)} disabled={disabled} />
          <Label htmlFor="require-selected" className="font-normal">
            Employees must name the knowledge sources they read (“all knowledge” reads nothing)
          </Label>
        </div>
        {options.sources.length ? (
          <Choices
            legend="Knowledge sources no employee may read"
            idPrefix="blocked-source"
            options={options.sources.map((source) => ({ value: source.id, label: source.name }))}
            selected={blocked}
            onChange={setBlocked}
            disabled={disabled}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No knowledge sources yet.</p>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2" aria-labelledby="limits-heading">
        <h3 id="limits-heading" className="font-medium sm:col-span-2">
          Limits (they only lower what each employee allows)
        </h3>
        {(
          [
            ['maxTaskRuntimeSeconds', 'Longest working time per task (seconds, 10–900)'],
            ['maxCostUsdPerTask', 'Most a task may spend (USD)'],
            ['employeeMonthlyUsd', 'Most one employee may spend per month (USD)'],
            ['organizationMonthlyUsd', 'Most the workspace may spend per month on AI (USD)'],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="flex flex-col gap-1.5">
            <Label htmlFor={`limit-${key}`}>{label}</Label>
            <Input id={`limit-${key}`} type="number" min={0} step="any" value={limits[key]} onChange={(event) => setLimits((current) => ({ ...current, [key]: event.target.value }))} disabled={disabled} placeholder="No limit" />
          </div>
        ))}
      </section>

      {result?.status === 'error' ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{result.message}</AlertDescription>
        </Alert>
      ) : result?.status === 'success' ? (
        <Alert aria-live="polite">
          <AlertDescription>{result.message}</AlertDescription>
        </Alert>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={pending}>
            <Save data-icon="inline-start" aria-hidden="true" />
            {pending ? 'Saving…' : value.id ? 'Save as a new revision' : 'Create policy'}
          </Button>
          {value.id ? (
            <ConfirmDialog
              trigger={
                <Button variant="outline" disabled={pending}>
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  Delete
                </Button>
              }
              title="Delete this policy?"
              description="It stops applying at once. Its revisions stay in the history and the audit log."
              confirmLabel="Delete policy"
              pendingLabel="Deleting…"
              destructive
              onConfirm={async () => {
                const outcome = await deletePolicy(organizationId, value.id!)
                if (outcome.status === 'success') router.push('/app/settings/governance')
                return outcome
              }}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only admins and owners can change policies.</p>
      )}
    </div>
  )
}

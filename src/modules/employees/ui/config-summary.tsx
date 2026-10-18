// Read-only view of one version's configuration (every reviewed field).

import { Badge } from '@/components/ui/badge'
import { EFFORT_LABELS, MODELS, TIER_LABELS } from '@/modules/models/domain/catalog'

import { DEPARTMENT_LABELS, ESCALATION_BEHAVIOR_LABELS, type ConnectionOption, type EmployeeConfig, type EmployeeToolInfo, type KnowledgeSourceOption } from '../domain/types'

function List({ items, empty = 'None' }: { items: readonly string[]; empty?: string }) {
  return items.length ? (
    <ul className="list-disc pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  ) : (
    <span className="text-muted-foreground">{empty}</span>
  )
}

export function approvalText(grant: EmployeeConfig['tools'][number], tool: EmployeeToolInfo | undefined): string {
  if (grant.approval === 'require_approval') return 'always asks for approval'
  return tool && tool.approvalRequirement !== 'none' ? 'follows the connection setting (approval by default)' : 'runs without asking'
}

export function ConfigSummary({
  instructions,
  config,
  tools,
  connections,
  sources,
}: {
  instructions: string
  config: EmployeeConfig
  tools: readonly EmployeeToolInfo[]
  connections: readonly ConnectionOption[]
  sources: readonly KnowledgeSourceOption[]
}) {
  const model = MODELS[config.model.tier]
  const rows: [string, React.ReactNode][] = [
    ['Name', config.profile.name],
    ['Department', DEPARTMENT_LABELS[config.profile.department]],
    ['Description', config.profile.description || <span className="text-muted-foreground">None</span>],
    ['Responsibilities', <List key="r" items={config.responsibilities} />],
    ['Instructions', <p key="i" className="whitespace-pre-wrap">{instructions}</p>],
    ['Skills', config.skills.length ? config.skills.map((skill) => <Badge key={skill} variant="outline" className="mr-1">{skill}</Badge>) : <span className="text-muted-foreground">None</span>],
    [
      'Authorized tools',
      config.tools.length ? (
        <ul key="t" className="list-disc pl-5">
          {config.tools.map((grant) => {
            const tool = tools.find((candidate) => candidate.key === grant.toolKey)
            const connection = connections.find((candidate) => candidate.id === grant.integrationId)
            return (
              <li key={grant.toolKey}>
                {tool?.title ?? grant.toolKey}
                {tool?.needsConnection ? ` via ${connection?.label ?? 'no connection chosen'}` : ''} — {approvalText(grant, tool)}
              </li>
            )
          })}
        </ul>
      ) : (
        <span className="text-muted-foreground">None</span>
      ),
    ],
    [
      'Knowledge access',
      config.knowledge.access === 'none'
        ? 'None'
        : config.knowledge.access === 'all'
          ? `All documents and business context (up to ${config.knowledge.maxPassages} passages per search)`
          : `Selected: ${config.knowledge.sourceIds.map((id) => sources.find((source) => source.id === id)?.name ?? 'removed document').join(', ')}`,
    ],
    ['Model', `${TIER_LABELS[config.model.tier].label} (${model.label}), effort ${EFFORT_LABELS[config.model.effort].split(':')[0]!.toLowerCase()}, up to ${config.model.maxOutputTokens.toLocaleString()} output tokens per step`],
    ['Success criteria', <List key="s" items={config.successCriteria} />],
    ['Allowed actions', <List key="a" items={config.allowedActions} />],
    ['Prohibited actions', <List key="p" items={config.prohibitedActions} />],
    [
      'Escalation',
      <div key="e">
        <List items={config.escalation.when} />
        <p className="mt-1">{ESCALATION_BEHAVIOR_LABELS[config.escalation.behavior]}.</p>
        {config.escalation.notes ? <p className="mt-1 text-muted-foreground">{config.escalation.notes}</p> : null}
      </div>,
    ],
    [
      'Execution limits',
      `${config.limits.maxTurnsPerTask} steps, ${config.limits.maxToolCallsPerTask} tool calls, ${config.limits.maxRuntimeSeconds} seconds and $${config.limits.maxCostUsdPerTask.toFixed(2)} per task`,
    ],
    ['Budget', `$${config.budget.monthlyUsd.toFixed(2)} per month`],
  ]
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-[12rem_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="font-medium text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

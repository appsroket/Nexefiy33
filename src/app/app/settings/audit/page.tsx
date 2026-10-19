import type { Metadata } from 'next'
import Link from 'next/link'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { createUserClient } from '@/lib/supabase/server'
import { hasMinRole } from '@/lib/supabase/types'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { AUDIT_GROUPS, listAuditLog, memberNames, type AuditEntry, type AuditGroup } from '@/modules/governance/server/queries'
import { SettingsTabs } from '@/modules/identity/ui/settings-tabs'

export const metadata: Metadata = { title: 'Audit log' }

const ACTOR_TYPES = { user: 'People', employee: 'AI employees', system: 'System', service: 'Service' } as const

function details(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .slice(0, 6)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key.replace(/_/g, ' ')}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`
    })
    .join(' · ')
}

function actorName(entry: AuditEntry, people: Map<string, string>, employees: Map<string, string>): string {
  if (entry.actorEmployeeId) return `${employees.get(entry.actorEmployeeId) ?? 'An AI employee'} (AI employee)`
  if (entry.actorUserId) return people.get(entry.actorUserId) ?? 'A former member'
  return entry.actorType === 'service' ? 'Nexefiy (service)' : 'Nexefiy (system)'
}

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const item = getNavItem('/app/settings')
  const gate = requireWorkspace(await getShellContext(), 'the audit log')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title={item.title} description={item.description} />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  if (!hasMinRole(workspace.role, 'admin')) {
    return (
      <>
        <PageHeader title="Audit log" description="Who did what in this workspace." />
        <SettingsTabs />
        <SectionCard title="Admins only">
          <p className="text-sm text-muted-foreground">Only admins and owners can read the audit log.</p>
        </SectionCard>
      </>
    )
  }

  const params = await searchParams
  const group = typeof params.group === 'string' && params.group in AUDIT_GROUPS ? (params.group as AuditGroup) : undefined
  const actorType = typeof params.actor === 'string' && params.actor in ACTOR_TYPES ? params.actor : undefined
  const before = typeof params.before === 'string' && /^\d+$/.test(params.before) ? Number(params.before) : undefined
  const supabase = await createUserClient()
  const [{ entries, next }, people, employees] = await Promise.all([
    listAuditLog(workspace.organizationId, { ...(group ? { group } : {}), ...(actorType ? { actorType } : {}), ...(before ? { before } : {}) }),
    memberNames(workspace.organizationId),
    supabase.from('ai_employees').select('id, name').eq('organization_id', workspace.organizationId),
  ])
  const employeeNames = new Map((employees.data ?? []).map((employee) => [employee.id, employee.name]))
  const query = (extra: Record<string, string | undefined>) => {
    const search = new URLSearchParams(Object.entries({ group, actor: actorType, ...extra }).filter((entry): entry is [string, string] => Boolean(entry[1])))
    const text = search.toString()
    return `/app/settings/audit${text ? `?${text}` : ''}`
  }

  return (
    <>
      <PageHeader title="Audit log" description="Who did what in this workspace — people, AI employees and the system. Entries can’t be changed or deleted, and are kept for at least a year." />
      <SettingsTabs />
      <SectionCard title="Entries">
        <form className="mb-4 flex flex-wrap items-end gap-3" aria-label="Filter the audit log">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Area</span>
            <select name="group" defaultValue={group ?? ''} className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30">
              <option value="">Everything</option>
              {Object.entries(AUDIT_GROUPS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Who</span>
            <select name="actor" defaultValue={actorType ?? ''} className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30">
              <option value="">Anyone</option>
              {Object.entries(ACTOR_TYPES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" size="sm">
            Filter
          </Button>
        </form>
        {entries.length ? (
          <ol className="flex flex-col divide-y">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs">{entry.action}</code>
                  <Badge variant="outline">{ACTOR_TYPES[entry.actorType as keyof typeof ACTOR_TYPES] ?? entry.actorType}</Badge>
                  <span className="text-muted-foreground">
                    <DateTime value={entry.occurredAt} />
                  </span>
                </div>
                <p>
                  {actorName(entry, people, employeeNames)}
                  {entry.targetTable ? <span className="text-muted-foreground"> · {entry.targetTable.replace(/_/g, ' ')}</span> : null}
                  {entry.targetId ? <span className="font-mono text-xs text-muted-foreground"> {entry.targetId.slice(0, 8)}</span> : null}
                </p>
                {Object.keys(entry.metadata).length ? <p className="break-words text-muted-foreground">{details(entry.metadata)}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No entries match.</p>
        )}
        {next ? (
          <div className="mt-4">
            <Button asChild variant="outline" size="sm">
              <Link href={query({ before: String(next) })}>Older entries</Link>
            </Button>
          </div>
        ) : null}
      </SectionCard>
    </>
  )
}

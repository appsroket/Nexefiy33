import { randomUUID } from 'node:crypto'

import { ArrowLeft, CircleCheck, FlaskConical, Info, Pencil } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { StatusIndicator } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { activationHint, availableActions, LIFECYCLE_DISPLAY } from '@/modules/employees/domain/lifecycle'
import { DEPARTMENT_LABELS, TEST_STATUS_DISPLAY } from '@/modules/employees/domain/types'
import { getEmployee, loadEditorOptions } from '@/modules/employees/server/queries'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { approvalText, ConfigSummary } from '@/modules/employees/ui/config-summary'
import { LifecycleControls, type ActivationSummary } from '@/modules/employees/ui/lifecycle-controls'
import { MODELS, TIER_LABELS } from '@/modules/models/domain/catalog'
import { TASK_STATUS_DISPLAY } from '@/modules/tasks/domain/labels'
import { listDependableTasks, listEmployeeTasks } from '@/modules/tasks/server/queries'
import { canRunTasks } from '@/modules/tasks/server/scheduling'
import { AssignTaskForm } from '@/modules/tasks/ui/task-controls'

export const metadata: Metadata = { title: 'AI employee' }
// Assigning a task (or deciding an approval) runs the task after the response, in this route's function.
export const maxDuration = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function EmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this employee')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="AI employee" />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const employee = await getEmployee(workspace.organizationId, id)
  if (!employee) notFound()
  const [options, query, tasks] = [
    await loadEditorOptions(workspace.organizationId),
    await searchParams,
    await listEmployeeTasks(workspace.organizationId, id, 10),
  ]
  const canAssign = employee.state === 'active' && hasMinRole(workspace.role, 'operator')
  const dependable = canAssign ? await listDependableTasks(workspace.organizationId) : []
  const tools = listEmployeeTools()

  const current = employee.versions.find((version) => version.id === employee.currentVersionId) ?? null
  const active = employee.versions.find((version) => version.id === employee.activeVersionId) ?? null
  const state = LIFECYCLE_DISPLAY[employee.state] ?? LIFECYCLE_DISPLAY.draft
  const canEdit = hasMinRole(workspace.role, 'operator') && employee.state !== 'archived'
  const view = {
    state: employee.state,
    role: workspace.role,
    currentTestStatus: current?.testStatus ?? 'untested',
    currentIsActive: Boolean(current && current.id === employee.activeVersionId),
  } as const
  const actions = availableActions(view)
  const hint = activationHint(view)

  const activation: ActivationSummary | null =
    current?.config && actions.includes('activate')
      ? {
          version: current.version,
          versionId: current.id,
          modelLabel: `${TIER_LABELS[current.config.model.tier].label} (${MODELS[current.config.model.tier].label})`,
          tools: current.config.tools.map((grant) => {
            const tool = tools.find((candidate) => candidate.key === grant.toolKey)
            return { title: tool?.title ?? grant.toolKey, approval: approvalText(grant, tool) }
          }),
          knowledge:
            current.config.knowledge.access === 'none' ? 'None' : current.config.knowledge.access === 'all' ? 'All documents and business context' : 'Selected documents',
          limits: `${current.config.limits.maxTurnsPerTask} steps, ${current.config.limits.maxToolCallsPerTask} tool calls, $${current.config.limits.maxCostUsdPerTask.toFixed(2)} per task`,
          budget: `$${current.config.budget.monthlyUsd.toFixed(2)} per month`,
        }
      : null

  return (
    <>
      <div>
        <Link href="/app/employees" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          AI employees
        </Link>
      </div>
      <PageHeader
        title={employee.name}
        description={employee.description ?? undefined}
        actions={
          <>
            <StatusIndicator tone={state.tone} label={state.label} />
            <Badge variant="outline">{DEPARTMENT_LABELS[employee.department] ?? employee.department}</Badge>
          </>
        }
      />
      {query.saved ? (
        <Alert role="status">
          <CircleCheck aria-hidden="true" />
          <AlertDescription>Saved as version {current?.version}. Run its tests in the playground before activating it.</AlertDescription>
        </Alert>
      ) : null}

      <SectionCard title="Status" description={state.meaning}>
        <div className="flex flex-col gap-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Latest version</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {current ? `Version ${current.version}` : '—'}
              {current ? <StatusIndicator tone={TEST_STATUS_DISPLAY[current.testStatus].tone} label={TEST_STATUS_DISPLAY[current.testStatus].label} /> : null}
            </dd>
            <dt className="text-muted-foreground">Active version</dt>
            <dd>
              {active ? (
                <>
                  Version {active.version}
                  {employee.activatedAt ? (
                    <span className="text-muted-foreground">
                      {' '}
                      (activated <DateTime value={employee.activatedAt} />)
                    </span>
                  ) : null}
                </>
              ) : (
                'None: this employee has not been activated'
              )}
            </dd>
          </dl>
          {active && current && active.id !== current.id ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertDescription>
                Version {current.version} has changes that aren’t active yet. Version {active.version} keeps running until version {current.version} passes its
                tests and is activated.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canEdit ? (
              <Button asChild variant="outline">
                <Link href={`/app/employees/${employee.id}/edit`}>
                  <Pencil data-icon="inline-start" aria-hidden="true" />
                  Edit
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href={`/app/employees/${employee.id}/playground`}>
                <FlaskConical data-icon="inline-start" aria-hidden="true" />
                Test playground
              </Link>
            </Button>
          </div>
          <LifecycleControls
            organizationId={workspace.organizationId}
            employeeId={employee.id}
            employeeName={employee.name}
            actions={actions}
            activation={activation}
            canDelete={employee.state === 'draft' && !employee.activatedAt && hasMinRole(workspace.role, 'operator')}
          />
          {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Tasks"
        description={
          employee.state === 'active'
            ? `Give this employee a bounded task. It runs version ${active?.version ?? '—'} with exactly its tools, limits and approval rules.`
            : 'Only an active employee can be given tasks.'
        }
      >
        <div className="flex flex-col gap-6">
          {canAssign ? (
            <>
              {canRunTasks() ? null : (
                <Alert>
                  <Info aria-hidden="true" />
                  <AlertDescription>
                    Tasks can be assigned, but they won’t run on this deployment until an AI model and the Supabase secret key are configured (see
                    docs/credential-setup.md).
                  </AlertDescription>
                </Alert>
              )}
              <AssignTaskForm
                employeeId={employee.id}
                requestKey={randomUUID()}
                dependable={dependable.map((task) => ({ id: task.id, title: task.title, statusLabel: TASK_STATUS_DISPLAY[task.status].label }))}
              />
            </>
          ) : null}
          {tasks.length ? (
            <ul className="flex flex-col divide-y text-sm">
              {tasks.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/app/tasks/${task.id}`} className="font-medium underline-offset-4 hover:underline">
                    {task.title}
                  </Link>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <StatusIndicator tone={TASK_STATUS_DISPLAY[task.status].tone} label={TASK_STATUS_DISPLAY[task.status].label} />
                    <DateTime value={task.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No tasks yet.</p>
          )}
        </div>
      </SectionCard>

      {current ? (
        <SectionCard title={`Configuration (version ${current.version})`}>
          {current.config ? (
            <ConfigSummary instructions={current.instructions} config={current.config} tools={tools} connections={options.connections} sources={options.sources} />
          ) : (
            <p className="text-sm text-muted-foreground">This version uses an older configuration format. Edit and save the employee to update it.</p>
          )}
        </SectionCard>
      ) : null}

      <SectionCard title="Version history" description="Versions can’t be changed after they are saved. Each one keeps its own test results.">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Saved</TableHead>
              <TableHead>What changed</TableHead>
              <TableHead>Tests</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {employee.versions.map((version) => (
              <TableRow key={version.id}>
                <TableCell className="font-medium">
                  v{version.version}
                  {version.id === employee.activeVersionId ? (
                    <Badge variant="secondary" className="ml-2">
                      Active
                    </Badge>
                  ) : null}
                  {version.id === employee.currentVersionId ? (
                    <Badge variant="outline" className="ml-2">
                      Latest
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  <DateTime value={version.createdAt} />
                </TableCell>
                <TableCell className="max-w-sm truncate">{version.changeNote ?? '—'}</TableCell>
                <TableCell>
                  <StatusIndicator tone={TEST_STATUS_DISPLAY[version.testStatus].tone} label={TEST_STATUS_DISPLAY[version.testStatus].label} />
                  <span className="ml-2 text-xs text-muted-foreground">
                    {version.passedRuns} passed · {version.failedRuns} failed
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  {canEdit && version.config && version.id !== employee.currentVersionId ? (
                    <Link href={`/app/employees/${employee.id}/edit?from=${version.id}`} className="text-sm underline-offset-4 hover:underline">
                      Start a new version from this one
                    </Link>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
    </>
  )
}

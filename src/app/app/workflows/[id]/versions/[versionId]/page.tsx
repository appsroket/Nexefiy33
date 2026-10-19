import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { getBuilderContext, getVersion, getWorkflow } from '@/modules/workflows/server/queries'
import { DECISION_TEXT, RISK_TEXT } from '@/modules/workflows/ui/labels'
import { WorkflowViewer } from '@/modules/workflows/ui/workflow-viewer'

export const metadata: Metadata = { title: 'Workflow version' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface StoredReport {
  warnings?: { message: string }[]
  permissions?: { label: string; toolKey: string; risk: string; decision: string; reason: string }[]
  handoffs?: { from: string; to: string; decision: string }[]
  checkedAt?: string
}

export default async function VersionPage({ params }: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await params
  if (!UUID.test(id) || !UUID.test(versionId)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this workflow version')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Workflow version" />
        {gate.fallback}
      </>
    )
  }
  const { organizationId } = gate.workspace
  const [workflow, version, context] = await Promise.all([getWorkflow(organizationId, id), getVersion(organizationId, id, versionId), getBuilderContext(organizationId)])
  if (!workflow || !version) notFound()
  const report = version.report as StoredReport

  return (
    <>
      <div>
        <Link href={`/app/workflows/${id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {workflow.name}
        </Link>
      </div>
      <PageHeader
        title={`${workflow.name} — version ${version.version}`}
        description="An activated version never changes. Runs that started on it keep using it exactly."
      />
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Activated</dt>
        <dd>
          <DateTime value={version.createdAt} />
        </dd>
        <dt className="text-muted-foreground">Fingerprint (SHA-256)</dt>
        <dd>
          <code className="text-xs break-all">{version.graphSha256}</code>
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{version.id === workflow.currentVersionId ? 'Current version' : 'Earlier version'}</dd>
      </dl>
      <WorkflowViewer definition={version.definition} layout={version.layout} context={context} />

      <SectionCard title="What this version may do" description={report.checkedAt ? 'Checked on the server when it was activated. Every action is checked again each time it runs.' : undefined}>
        {report.permissions?.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {report.permissions.map((line, position) => (
              <li key={position}>
                <span className="font-medium">{line.label}</span>: <code className="text-xs">{line.toolKey}</code> — {RISK_TEXT[line.risk] ?? line.risk}; {DECISION_TEXT[line.decision] ?? line.decision}. <span className="text-muted-foreground">{line.reason}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No integration actions.</p>
        )}
        {report.handoffs?.length ? (
          <>
            <h3 className="mt-3 text-sm font-medium">Hand-offs between employees</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {report.handoffs.map((handoff, position) => (
                <li key={position}>
                  {handoff.from} → {handoff.to}: {handoff.decision === 'allow' ? 'allowed by workspace policy' : 'workspace policy requires an approval step between them (present)'}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {report.warnings?.length ? (
          <>
            <h3 className="mt-3 text-sm font-medium">Warnings at activation</h3>
            <ul className="list-disc pl-4 text-sm">
              {report.warnings.map((warning, position) => (
                <li key={position}>{warning.message}</li>
              ))}
            </ul>
          </>
        ) : null}
      </SectionCard>

      <SectionCard title="Definition (JSON)">
        <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(version.definition, null, 2)}</pre>
      </SectionCard>
    </>
  )
}

import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { StatusBadge } from '@/components/status-badge'
import { hasMinRole } from '@/lib/supabase/types'
import { isOrganizationRole, roleLabel } from '@/modules/app-shell/domain/workspace'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { getApprovalRequest } from '@/modules/governance/server/approvals'
import { ApprovalDecision } from '@/modules/governance/ui/approval-decision'

export const metadata: Metadata = { title: 'Approval request' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this approval request')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Approval request" />
        {gate.fallback}
      </>
    )
  }
  const request = await getApprovalRequest(gate.workspace.organizationId, id)
  if (!request) notFound()

  const required = isOrganizationRole(request.requiredRole) ? request.requiredRole : 'owner'
  const canDecide = hasMinRole(gate.workspace.role, required)
  // An expired request still shows as pending until someone acts on it; decide_approval then marks it expired.
  const pending = request.status === 'pending'
  const { input, ...about } = request.proposedAction

  return (
    <>
      <div>
        <Link href="/app/approvals" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Approvals
        </Link>
      </div>
      <PageHeader title={request.actionSummary} actions={<StatusBadge kind="approval" status={request.status} />} />

      <SectionCard title="What will happen" description="The exact action that runs if this is approved. It runs once, with this input, through the connection shown.">
        <div className="flex flex-col gap-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            {typeof about.actionTitle === 'string' ? (
              <>
                <dt className="text-muted-foreground">Action</dt>
                <dd>
                  {about.actionTitle} {typeof about.action === 'string' ? <code className="text-xs text-muted-foreground">({about.action})</code> : null}
                </dd>
              </>
            ) : null}
            {typeof about.connection === 'string' ? (
              <>
                <dt className="text-muted-foreground">Connection</dt>
                <dd>{about.connection}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Requested</dt>
            <dd>
              <DateTime value={request.createdAt} />
            </dd>
            <dt className="text-muted-foreground">Expires</dt>
            <dd>
              <DateTime value={request.expiresAt} />
            </dd>
            <dt className="text-muted-foreground">Who can decide</dt>
            <dd>{roleLabel(required)} or above</dd>
          </dl>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Input</h3>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{JSON.stringify(input ?? request.proposedAction, null, 2)}</pre>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Decision">
        {pending ? (
          canDecide ? (
            <ApprovalDecision requestId={request.id} payloadSha256={request.payloadSha256} />
          ) : (
            <p className="text-sm text-muted-foreground">Only members with the {roleLabel(required)} role or above can decide this request.</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            This request is closed.
            {request.decidedAt ? (
              <>
                {' '}
                (<DateTime value={request.decidedAt} />)
              </>
            ) : null}
            {request.decisionNote ? ` Note: ${request.decisionNote}` : null}
          </p>
        )}
      </SectionCard>
    </>
  )
}

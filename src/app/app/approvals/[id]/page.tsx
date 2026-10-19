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
import { ACTION_CATEGORY_INFO, RISK_TIER_INFO, type ActionCategory } from '@/modules/governance/domain/risk'
import { getApprovalRequest } from '@/modules/governance/server/approvals'
import { ApprovalDecision } from '@/modules/governance/ui/approval-decision'

export const metadata: Metadata = { title: 'Approval request' }
// An approval decision runs the action and the waiting task after the response, in this route's function.
export const maxDuration = 300

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

      {request.kind === 'workflow_gate' ? (
        <SectionCard title="What you are approving" description="An approval step of a workflow run. You approve exactly this text; the run then continues on its approved path (or its rejected path if you reject).">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Workflow</dt>
            <dd>
              {typeof about.workflow === 'string' ? about.workflow : 'Workflow'}
              {typeof about.version === 'number' ? ` (version ${about.version})` : ''}
            </dd>
            <dt className="text-muted-foreground">Step</dt>
            <dd>{typeof about.step === 'string' ? about.step : '—'}</dd>
            {request.workflowRunId ? (
              <>
                <dt className="text-muted-foreground">Run</dt>
                <dd>
                  <Link href={`/app/workflows/runs/${request.workflowRunId}`} className="underline underline-offset-4">
                    Open the run
                  </Link>
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Expires</dt>
            <dd>
              <DateTime value={request.expiresAt} />
            </dd>
            <dt className="text-muted-foreground">Who can decide</dt>
            <dd>{roleLabel(required)} or above</dd>
          </dl>
          <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">{typeof about.message === 'string' ? about.message : ''}</pre>
        </SectionCard>
      ) : (
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
              <dd>
                {roleLabel(required)} or above{request.separateApprover ? ', not the person who requested it' : ''}
              </dd>
              {request.category && request.category in ACTION_CATEGORY_INFO ? (
                <>
                  <dt className="text-muted-foreground">Risk</dt>
                  <dd>
                    {ACTION_CATEGORY_INFO[request.category as ActionCategory].label} ·{' '}
                    {RISK_TIER_INFO[ACTION_CATEGORY_INFO[request.category as ActionCategory].tier].label}
                  </dd>
                </>
              ) : null}
            </dl>
            <p className="text-sm text-muted-foreground">
              Your approval holds only for this exact input, on this connection’s account, while you keep the role it needs and workspace policy still allows it. If any of
              that changes before it runs, the approval is void and the action doesn’t run.
            </p>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Input</h3>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{JSON.stringify(input ?? request.proposedAction, null, 2)}</pre>
            </div>
          </div>
        </SectionCard>
      )}

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

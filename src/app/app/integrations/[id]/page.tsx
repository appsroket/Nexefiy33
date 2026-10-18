import { ArrowLeft, CircleAlert, CircleCheck, History } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { StatusBadge, StatusIndicator } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { hasMinRole } from '@/lib/supabase/types'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { MIN_ROLE_TO_MANAGE_INTEGRATIONS, MIN_ROLE_TO_RUN_ACTIONS } from '@/modules/integrations/domain/policy'
import { APPROVAL_MODE_LABELS } from '@/modules/integrations/domain/types'
import { getConnection, getConnectorSummary, listActionSettings, listRecentExecutions } from '@/modules/integrations/server/queries'
import { ActionConsole } from '@/modules/integrations/ui/action-console'
import { ActionsPanel } from '@/modules/integrations/ui/actions-panel'
import { ConnectButton, ConnectionControls } from '@/modules/integrations/ui/connection-controls'
import { HEALTH_DISPLAY } from '@/modules/integrations/ui/labels'

export const metadata: Metadata = { title: 'Integration' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function summarize(value: unknown): string {
  if (value === null || value === undefined) return '—'
  const text = JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

export default async function IntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const gate = requireWorkspace(await getShellContext(), 'this integration')
  if (!gate.ok) {
    return (
      <>
        <PageHeader title="Integration" />
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const connection = await getConnection(workspace.organizationId, id)
  if (!connection) notFound()
  const connector = getConnectorSummary(connection.provider)
  if (!connector) notFound()

  const [settings, executions] = await Promise.all([
    listActionSettings(workspace.organizationId, id),
    listRecentExecutions(workspace.organizationId, id),
  ])
  const query = await searchParams
  const canManage = hasMinRole(workspace.role, MIN_ROLE_TO_MANAGE_INTEGRATIONS)
  const canRun = hasMinRole(workspace.role, MIN_ROLE_TO_RUN_ACTIONS)
  const connected = connection.status === 'connected'
  const missingScopes = connector.auth.scopes.filter((scope) => !connection.grantedScopes.includes(scope))
  const health = HEALTH_DISPLAY[connection.healthStatus]
  const approvalModes = Object.fromEntries(settings.map((setting) => [setting.actionKey, setting.enabled ? APPROVAL_MODE_LABELS[setting.approvalMode] : 'Off']))

  return (
    <>
      <div>
        <Link href="/app/integrations" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Integrations
        </Link>
      </div>
      <PageHeader
        title={`${connector.displayName}: ${connection.accountLabel ?? connection.displayName}`}
        description={connector.description}
        actions={<StatusBadge kind="integration" status={connection.status} />}
      />
      {query.connected ? (
        <Alert role="status">
          <CircleCheck aria-hidden="true" />
          <AlertDescription>Connected. Try an action below to confirm it works with your account.</AlertDescription>
        </Alert>
      ) : null}

      <SectionCard title="Connection">
        <div className="flex flex-col gap-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Account</dt>
            <dd>
              {connection.accountLabel ?? '—'} {connection.externalAccountId ? <code className="text-xs text-muted-foreground">({connection.externalAccountId})</code> : null}
            </dd>
            <dt className="text-muted-foreground">Health</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <StatusIndicator tone={health.tone} label={health.label} />
              {connection.healthMessage ? <span className="text-muted-foreground">{connection.healthMessage}</span> : null}
              {connection.lastHealthCheckAt ? (
                <span className="text-xs text-muted-foreground">
                  (checked <DateTime value={connection.lastHealthCheckAt} />)
                </span>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">Granted permissions</dt>
            <dd className="font-mono text-xs leading-5">{connection.grantedScopes.length ? connection.grantedScopes.join(', ') : '—'}</dd>
            <dt className="text-muted-foreground">Token renewal</dt>
            <dd>{connector.auth.tokenRefresh === 'refresh_token' ? 'Renewed automatically before it expires.' : 'Renewed automatically when the provider issues expiring tokens.'}</dd>
            <dt className="text-muted-foreground">Disconnecting</dt>
            <dd>{connector.auth.revocation}</dd>
            {connection.connectedAt ? (
              <>
                <dt className="text-muted-foreground">Connected</dt>
                <dd>
                  <DateTime value={connection.connectedAt} />
                </dd>
              </>
            ) : null}
            {connection.revokedAt ? (
              <>
                <dt className="text-muted-foreground">Disconnected</dt>
                <dd>
                  <DateTime value={connection.revokedAt} />
                </dd>
              </>
            ) : null}
          </dl>
          {connection.lastError && connection.status !== 'connected' ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{connection.lastError}</AlertDescription>
            </Alert>
          ) : null}
          {connected && missingScopes.length ? (
            <Alert>
              <CircleAlert aria-hidden="true" />
              <AlertDescription>Some permissions weren’t granted ({missingScopes.join(', ')}); actions that need them won’t run. Reconnect to grant them.</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-start gap-2">
            <ConnectionControls
              organizationId={workspace.organizationId}
              integrationId={connection.id}
              providerName={connector.displayName}
              canManage={canManage}
              connected={connected}
            />
            {canManage && (connection.status === 'needs_reauth' || connection.status === 'error' || (connected && missingScopes.length > 0)) ? (
              <ConnectButton
                organizationId={workspace.organizationId}
                provider={connector.provider}
                providerName={connector.displayName}
                integrationId={connection.id}
                disabled={!connector.configured}
              />
            ) : null}
            {canManage && connection.status === 'revoked' ? (
              <ConnectButton organizationId={workspace.organizationId} provider={connector.provider} providerName={connector.displayName} disabled={!connector.configured} />
            ) : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Actions" description="What AI employees and workflows can do through this connection, and the rules each action follows.">
        <ActionsPanel
          organizationId={workspace.organizationId}
          integrationId={connection.id}
          actions={connector.actions}
          settings={settings}
          grantedScopes={connection.grantedScopes}
          canManage={canManage && connected}
        />
      </SectionCard>

      {connected && canRun ? (
        <SectionCard
          title="Test an action"
          description="Runs against the connected account with the same checks, approvals and limits as an AI employee. Use a test account: actions are real."
        >
          <ActionConsole organizationId={workspace.organizationId} integrationId={connection.id} actions={connector.actions} approvalModes={approvalModes} />
        </SectionCard>
      ) : null}

      <SectionCard title="Recent activity" description="The latest actions requested through this connection. Long text is shortened here; credentials are never stored with them.">
        {executions.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Details</TableHead>
                <TableHead className="hidden sm:table-cell">Requested</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {executions.map((execution) => (
                <TableRow key={execution.id}>
                  <TableCell>
                    <code className="text-xs">{execution.toolKey}</code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="toolExecution" status={execution.status} />
                  </TableCell>
                  <TableCell className="hidden max-w-md text-xs text-muted-foreground md:table-cell">
                    <span className="line-clamp-3 break-all">
                      {execution.error?.message ? execution.error.message : execution.status === 'succeeded' ? summarize(execution.output) : summarize(execution.input)}
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <DateTime value={execution.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState icon={History} title="No activity yet" description="Actions run through this connection will appear here." />
        )}
      </SectionCard>
    </>
  )
}

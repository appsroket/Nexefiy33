import { CircleAlert, CircleCheck, ExternalLink } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { SectionCard } from '@/components/cards'
import { DateTime } from '@/components/date-time'
import { PageHeader } from '@/components/page-header'
import { StatusBadge, StatusIndicator } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { hasMinRole } from '@/lib/supabase/types'
import { getNavItem } from '@/modules/app-shell/domain/navigation'
import { getShellContext } from '@/modules/app-shell/server/shell-context'
import { requireWorkspace } from '@/modules/app-shell/ui/workspace-gate'
import { MIN_ROLE_TO_MANAGE_INTEGRATIONS } from '@/modules/integrations/domain/policy'
import { listConnections, listConnectorSummaries } from '@/modules/integrations/server/queries'
import { ConnectButton } from '@/modules/integrations/ui/connection-controls'
import { connectErrorMessage, HEALTH_DISPLAY } from '@/modules/integrations/ui/labels'

export const metadata: Metadata = { title: 'Integrations' }

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const item = getNavItem('/app/integrations')
  const header = <PageHeader title={item.title} description={item.description} />
  const gate = requireWorkspace(await getShellContext(), 'integrations')
  if (!gate.ok) {
    return (
      <>
        {header}
        {gate.fallback}
      </>
    )
  }
  const { workspace } = gate
  const params = await searchParams
  const connectError = connectErrorMessage(typeof params.connect_error === 'string' ? params.connect_error : undefined)
  const canManage = hasMinRole(workspace.role, MIN_ROLE_TO_MANAGE_INTEGRATIONS)
  const [connectors, connections] = [listConnectorSummaries(), await listConnections(workspace.organizationId)]

  return (
    <>
      {header}
      {connectError ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{connectError}</AlertDescription>
        </Alert>
      ) : null}
      <p className="max-w-2xl text-sm text-muted-foreground">
        Every action runs through server-side checks: the connection must belong to this workspace and hold the needed permission, and
        actions that change data in another app wait for approval unless an admin decides otherwise. Credentials are encrypted and never
        shown.
      </p>
      {connectors.map((connector) => {
        const own = connections.filter((connection) => connection.provider === connector.provider)
        const active = own.filter((connection) => connection.status !== 'revoked')
        return (
          <SectionCard
            key={connector.provider}
            title={connector.displayName}
            description={connector.description}
            action={<Badge variant="secondary">{connector.category === 'crm' ? 'CRM' : 'Communication'}</Badge>}
          >
            <div className="flex flex-col gap-4">
              {!connector.configured ? (
                <Alert>
                  <CircleAlert aria-hidden="true" />
                  <AlertDescription>
                    Not set up on this deployment: it needs the {connector.displayName} app credentials, the credential encryption keys and the
                    Supabase secret key (docs/credential-setup.md).
                  </AlertDescription>
                </Alert>
              ) : null}
              {active.length ? (
                <ul className="flex flex-col divide-y rounded-lg border">
                  {active.map((connection) => (
                    <li key={connection.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div className="flex min-w-0 flex-col">
                        <Link href={`/app/integrations/${connection.id}`} className="truncate font-medium underline-offset-4 hover:underline">
                          {connection.accountLabel ?? connection.displayName}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {connection.connectedAt ? (
                            <>
                              Connected <DateTime value={connection.connectedAt} />
                            </>
                          ) : (
                            'Not connected yet'
                          )}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge kind="integration" status={connection.status} />
                        {connection.status === 'connected' ? (
                          <StatusIndicator tone={HEALTH_DISPLAY[connection.healthStatus].tone} label={HEALTH_DISPLAY[connection.healthStatus].label} />
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CircleCheck className="size-4" aria-hidden="true" />
                  {connector.actions.length} actions available once connected: {connector.actions.map((action) => action.title.toLowerCase()).join(', ')}.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {canManage ? (
                  <ConnectButton
                    organizationId={workspace.organizationId}
                    provider={connector.provider}
                    providerName={connector.displayName}
                    disabled={!connector.configured}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">Admins and owners can connect accounts.</p>
                )}
                <a href={connector.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline">
                  Provider API docs
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </div>
              {own.length > active.length ? (
                <p className="text-xs text-muted-foreground">
                  {own.length - active.length} disconnected {own.length - active.length === 1 ? 'connection is' : 'connections are'} kept for history:{' '}
                  {own
                    .filter((connection) => connection.status === 'revoked')
                    .map((connection) => (
                      <Link key={connection.id} href={`/app/integrations/${connection.id}`} className="underline-offset-4 hover:underline">
                        {connection.accountLabel ?? connection.displayName}
                      </Link>
                    ))
                    .reduce<ReactNode[]>((list, link, index) => (index ? [...list, ', ', link] : [link]), [])}
                </p>
              ) : null}
            </div>
          </SectionCard>
        )
      })}
    </>
  )
}

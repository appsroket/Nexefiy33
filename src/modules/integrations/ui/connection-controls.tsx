'use client'

// Buttons that change a connection: connect / reconnect (starts OAuth),
// check health, and disconnect (revokes access at the provider).

import { Activity, CircleAlert, CircleCheck, Plug, Unplug } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { ActionState } from '@/lib/forms/action-state'

import { checkIntegrationHealth, disconnectIntegration, startConnection } from '../server/actions'

function Feedback({ state }: { state: ActionState | null }) {
  if (!state || state.status === 'idle') return null
  if (state.status === 'success') {
    return (
      <Alert role="status">
        <CircleCheck aria-hidden="true" />
        <AlertDescription>{state.message ?? 'Done.'}</AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive" role="alert">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{state.message}</AlertDescription>
    </Alert>
  )
}

export function ConnectButton({
  organizationId,
  provider,
  providerName,
  integrationId,
  disabled,
}: {
  organizationId: string
  provider: string
  providerName: string
  integrationId?: string
  disabled?: boolean
}) {
  const [state, setState] = useState<ActionState | null>(null)
  const [pending, startTransition] = useTransition()
  const label = integrationId ? 'Reconnect' : `Connect ${providerName}`

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant={integrationId ? 'outline' : 'default'}
          disabled={disabled || pending}
          onClick={() =>
            startTransition(async () => {
              // On success the action redirects to the provider and never returns.
              setState(await startConnection(organizationId, provider, integrationId))
            })
          }
        >
          {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Plug data-icon="inline-start" aria-hidden="true" />}
          {label}
        </Button>
      </div>
      <Feedback state={state} />
    </div>
  )
}

export function ConnectionControls({
  organizationId,
  integrationId,
  providerName,
  canManage,
  connected,
}: {
  organizationId: string
  integrationId: string
  providerName: string
  canManage: boolean
  connected: boolean
}) {
  const router = useRouter()
  const [state, setState] = useState<ActionState | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {connected ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setState(await checkIntegrationHealth(organizationId, integrationId))
                router.refresh()
              })
            }
          >
            {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Activity data-icon="inline-start" aria-hidden="true" />}
            Check connection
          </Button>
        ) : null}
        {canManage && connected ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline">
                <Unplug data-icon="inline-start" aria-hidden="true" />
                Disconnect
              </Button>
            }
            title={`Disconnect ${providerName}?`}
            description={`Nexefiy will revoke its access at ${providerName}, delete the stored credentials, and cancel actions still waiting for approval. Past activity stays in the history. You can connect again later.`}
            confirmLabel="Disconnect"
            pendingLabel="Disconnecting…"
            destructive
            onConfirm={async () => {
              const result = await disconnectIntegration(organizationId, integrationId)
              setState(result)
              router.refresh()
              return result
            }}
          />
        ) : null}
      </div>
      <Feedback state={state} />
    </div>
  )
}

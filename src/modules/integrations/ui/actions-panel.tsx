'use client'

// What a connection can do: each action's declared contract (risk, approval,
// scopes, idempotency, timeout, retries, rate limit) and, for admins, the
// per-connection setting (enabled, approval mode).

import { CircleAlert, CircleCheck } from 'lucide-react'
import { useActionState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { IDLE_ACTION_STATE } from '@/lib/forms/action-state'

import { ACTION_CATEGORY_INFO, isConsequential, RISK_TIER_INFO } from '@/modules/governance/domain/risk'

import type { ActionSettingView } from '../server/queries'
import { updateActionSetting } from '../server/actions'
import { allowedApprovalModes } from '../domain/policy'
import { APPROVAL_MODE_LABELS, RISK_LABELS, type ActionSummary, type ApprovalMode } from '../domain/types'

const SELECT_CLASS =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'

function idempotencyLabel(action: ActionSummary): string {
  switch (action.idempotency.kind) {
    case 'read_only':
      return 'Read only — safe to repeat.'
    case 'natural_key':
      return `Deduplicated by ${action.idempotency.key}: ${action.idempotency.description}`
    case 'not_idempotent':
      return `Not repeatable: ${action.idempotency.description}`
  }
}

function approvalModesFor(action: ActionSummary): ApprovalMode[] {
  return allowedApprovalModes(action.approval, action.risk, action.category)
}

/** A stored "allow" no longer counts for a consequential action; show what applies. */
function effectiveMode(action: ActionSummary, setting: ActionSettingView | undefined): ApprovalMode {
  const mode = setting?.approvalMode ?? action.defaultApprovalMode
  return approvalModesFor(action).includes(mode) ? mode : 'require_approval'
}

function SettingForm({
  organizationId,
  integrationId,
  action,
  setting,
}: {
  organizationId: string
  integrationId: string
  action: ActionSummary
  setting: ActionSettingView | undefined
}) {
  const [state, formAction, pending] = useActionState(updateActionSetting, IDLE_ACTION_STATE)
  const enabled = setting?.enabled ?? true
  const mode = effectiveMode(action, setting)

  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label={`Settings for ${action.title}`}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="integrationId" value={integrationId} />
      <input type="hidden" name="actionKey" value={action.key} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm">
          <span className="sr-only">Status for {action.title}</span>
          <select name="enabled" defaultValue={enabled ? 'on' : 'off'} className={SELECT_CLASS}>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <span className="sr-only">Approval for {action.title}</span>
          <select name="approvalMode" defaultValue={mode} className={SELECT_CLASS}>
            {approvalModesFor(action).map((option) => (
              <option key={option} value={option}>
                {APPROVAL_MODE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
          Save
        </Button>
      </div>
      {state.status === 'error' ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
          <CircleAlert className="size-4" aria-hidden="true" />
          {state.message}
        </p>
      ) : state.status === 'success' ? (
        <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CircleCheck className="size-4" aria-hidden="true" />
          Saved.
        </p>
      ) : null}
    </form>
  )
}

export function ActionsPanel({
  organizationId,
  integrationId,
  actions,
  settings,
  grantedScopes,
  canManage,
}: {
  organizationId: string
  integrationId: string
  actions: ActionSummary[]
  settings: ActionSettingView[]
  grantedScopes: string[]
  canManage: boolean
}) {
  return (
    <ul className="flex flex-col divide-y">
      {actions.map((action) => {
        const setting = settings.find((item) => item.actionKey === action.key)
        const missing = action.scopes.filter((scope) => !grantedScopes.includes(scope))
        return (
          <li key={action.key} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{action.title}</h3>
              <code className="text-xs text-muted-foreground">{action.key}</code>
              <Badge variant={action.risk === 'read' ? 'secondary' : 'outline'}>{RISK_LABELS[action.risk]}</Badge>
              <Badge variant="outline">
                {ACTION_CATEGORY_INFO[action.category].label} · {RISK_TIER_INFO[ACTION_CATEGORY_INFO[action.category].tier].label} risk
              </Badge>
              {setting && !setting.enabled ? <Badge variant="outline">Off</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">{action.description}</p>
            {missing.length ? (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>Not granted: {missing.join(', ')}. Reconnect to allow this action.</AlertDescription>
              </Alert>
            ) : null}
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Approval</dt>
              <dd>
                {APPROVAL_MODE_LABELS[effectiveMode(action, setting)]}
                {action.approval === 'always'
                  ? ' (always required)'
                  : isConsequential(action.category)
                    ? ' (only a workspace policy can let it run without approval)'
                    : ''}
              </dd>
              <dt className="text-muted-foreground">Scopes</dt>
              <dd className="font-mono text-xs leading-5">{action.scopes.join(', ')}</dd>
              <dt className="text-muted-foreground">Repeats</dt>
              <dd>{idempotencyLabel(action)}</dd>
              <dt className="text-muted-foreground">Time limit</dt>
              <dd>
                {action.timeoutMs / 1000} s per attempt, up to {action.retry.maxAttempts} attempts for temporary failures
              </dd>
              <dt className="text-muted-foreground">Rate limit</dt>
              <dd>
                {action.rateLimit.limit} per {action.rateLimit.windowSeconds} s ({action.rateLimit.source})
              </dd>
            </dl>
            {canManage ? <SettingForm organizationId={organizationId} integrationId={integrationId} action={action} setting={setting} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

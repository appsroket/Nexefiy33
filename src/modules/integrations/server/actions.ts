'use server'

// Server Actions for integrations: disconnect, health check, action settings,
// and the test console that runs an action against the connected account.
//
// Each action confirms the session with Supabase Auth and reads the caller's
// role in the workspace under RLS before using the service role. Ids from the
// browser are validated, never trusted: every service-role query is scoped to
// the organization the caller is a verified member of. Connecting happens in
// route handlers (/api/integrations/[provider]/connect and /callback).

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { FeatureUnavailableError } from '@/lib/env/server'
import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { redact } from '@/lib/logging/redact'
import { createRateLimiter } from '@/lib/rate-limit'
import { createUserClient } from '@/lib/supabase/server'
import { hasMinRole } from '@/lib/supabase/types'
import { SESSION_ENDED_MESSAGE } from '@/modules/identity/server/session'

import { findAction, getConnector } from '../connectors/registry'
import { isIntegrationError, type NormalizedError } from '../domain/errors'
import { allowedApprovalModes, MIN_ROLE_TO_MANAGE_INTEGRATIONS, MIN_ROLE_TO_RUN_ACTIONS } from '../domain/policy'
import { APPROVAL_MODES } from '../domain/types'
import { checkHealth, disconnect } from './connections'
import { requestAction } from './executor'
import { getVerifiedMember } from './membership'
import { startAuthorization } from './oauth'
import { getIntegrationRuntime, isConnectorConfigured } from './runtime'

const NOT_ALLOWED = 'You don’t have permission to do that in this workspace.'
const ADMINS_ONLY = 'Only admins and owners can manage integrations.'
const NOT_CONFIGURED = 'Integrations aren’t set up on this deployment yet (see docs/credential-setup.md).'
const MAX_INPUT_BYTES = 20_000

const healthLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 })
const runLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 })

const uuid = z.uuid()

function readUuid(value: unknown): string | null {
  const parsed = uuid.safeParse(value)
  return parsed.success ? parsed.data : null
}

function refresh(integrationId?: string) {
  revalidatePath('/app/integrations')
  if (integrationId) revalidatePath(`/app/integrations/${integrationId}`)
}

function runtimeOrNull() {
  try {
    return getIntegrationRuntime()
  } catch (error) {
    if (error instanceof FeatureUnavailableError) return null
    throw error
  }
}

async function member(organizationId: string, minimum: typeof MIN_ROLE_TO_RUN_ACTIONS) {
  const check = await getVerifiedMember(organizationId)
  if (check.status === 'signed_out') return { ok: false as const, state: actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended') }
  if (check.status !== 'ok') return { ok: false as const, state: actionError(NOT_ALLOWED) }
  if (!hasMinRole(check.role, minimum)) {
    return { ok: false as const, state: actionError(minimum === MIN_ROLE_TO_MANAGE_INTEGRATIONS ? ADMINS_ONLY : NOT_ALLOWED) }
  }
  return { ok: true as const, user: check.user, role: check.role }
}

/**
 * Starts the OAuth flow and sends the browser to the provider. A Server Action
 * (not a link) so Next.js's origin check stops other sites from starting it.
 * Pass integrationId to reconnect an existing connection.
 */
export async function startConnection(organizationId: string, provider: string, integrationId?: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const existing = integrationId === undefined ? undefined : readUuid(integrationId)
  const connector = getConnector(provider)
  if (!org || !connector || existing === null) return actionError(NOT_ALLOWED)
  const caller = await member(org, MIN_ROLE_TO_MANAGE_INTEGRATIONS)
  if (!caller.ok) return caller.state
  if (!isConnectorConfigured(connector)) return actionError(`${connector.displayName} isn’t set up on this deployment yet (see docs/credential-setup.md).`)
  const runtime = runtimeOrNull()
  if (!runtime) return actionError(NOT_CONFIGURED)

  let url: string
  try {
    url = await startAuthorization(runtime, connector, {
      organizationId: org,
      userId: caller.user.id,
      ...(existing ? { integrationId: existing, returnPath: `/app/integrations/${existing}` } : {}),
    })
  } catch (error) {
    if (isIntegrationError(error)) return actionError(error.message)
    throw error
  }
  redirect(url)
}

export async function disconnectIntegration(organizationId: string, integrationId: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const id = readUuid(integrationId)
  if (!org || !id) return actionError(NOT_ALLOWED)
  const caller = await member(org, MIN_ROLE_TO_MANAGE_INTEGRATIONS)
  if (!caller.ok) return caller.state
  const runtime = runtimeOrNull()
  if (!runtime) return actionError(NOT_CONFIGURED)

  try {
    const result = await disconnect(runtime, { organizationId: org, integrationId: id, userId: caller.user.id })
    refresh(id)
    const cancelled = result.cancelledExecutions ? ` ${result.cancelledExecutions} pending action(s) were cancelled.` : ''
    if (result.revocation === 'failed') {
      return actionSuccess(
        `Disconnected and credentials deleted, but the provider couldn’t confirm revocation (${result.revocationError}). Remove the app from the provider’s settings to be sure.${cancelled}`,
      )
    }
    return actionSuccess(`Disconnected. Access was revoked at the provider and stored credentials were deleted.${cancelled}`)
  } catch (error) {
    if (isIntegrationError(error)) return actionError(error.message)
    console.error('[integrations] disconnect failed', redact(error))
    return actionError('We couldn’t disconnect this integration. Please try again.')
  }
}

export async function checkIntegrationHealth(organizationId: string, integrationId: string): Promise<ActionState> {
  const org = readUuid(organizationId)
  const id = readUuid(integrationId)
  if (!org || !id) return actionError(NOT_ALLOWED)
  const caller = await member(org, MIN_ROLE_TO_RUN_ACTIONS)
  if (!caller.ok) return caller.state
  if (!healthLimiter(caller.user.id)) return actionError('Too many checks in a short time. Wait a minute and try again.')
  const runtime = runtimeOrNull()
  if (!runtime) return actionError(NOT_CONFIGURED)

  try {
    const report = await checkHealth(runtime, org, id)
    refresh(id)
    return report.status === 'healthy' ? actionSuccess(report.message) : actionError(report.message)
  } catch (error) {
    if (isIntegrationError(error)) return actionError(error.message)
    console.error('[integrations] health check failed', redact(error))
    return actionError('The health check couldn’t run. Please try again.')
  }
}

const settingSchema = z.object({
  organizationId: z.uuid(),
  integrationId: z.uuid(),
  actionKey: z.string().max(100),
  enabled: z.enum(['on', 'off']),
  approvalMode: z.enum(APPROVAL_MODES),
})

export async function updateActionSetting(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = settingSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return actionError(NOT_ALLOWED)
  const { organizationId, integrationId, actionKey, enabled, approvalMode } = parsed.data
  const found = findAction(actionKey)
  if (!found) return actionError(NOT_ALLOWED)
  if (!allowedApprovalModes(found.action.approval, found.action.risk, found.action.category).includes(approvalMode)) {
    return actionError('This action needs approval unless a workspace policy explicitly permits it, so a connection setting can’t let it run without approval.')
  }

  // Runs under the user's session: RLS lets only admins change action settings.
  const supabase = await createUserClient()
  const caller = await member(organizationId, MIN_ROLE_TO_MANAGE_INTEGRATIONS)
  if (!caller.ok) return caller.state

  const { data: connection } = await supabase
    .from('integrations')
    .select('provider')
    .eq('id', integrationId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (!connection || connection.provider !== found.connector.provider) return actionError(NOT_ALLOWED)

  const values = { enabled: enabled === 'on', approval_mode: approvalMode }
  const updated = await supabase
    .from('integration_actions')
    .update(values)
    .eq('integration_id', integrationId)
    .eq('organization_id', organizationId)
    .eq('action_key', actionKey)
    .select('id')
  if (updated.error) {
    if (updated.error.code === '42501') return actionError(ADMINS_ONLY)
    console.error('[integrations] updating an action setting failed', redact({ code: updated.error.code }))
    return actionError('We couldn’t save this setting. Please try again.')
  }
  if (updated.data.length === 0) {
    const inserted = await supabase
      .from('integration_actions')
      .insert({ organization_id: organizationId, integration_id: integrationId, action_key: actionKey, risk_level: found.action.risk, ...values })
      .select('id')
    if (inserted.error || inserted.data.length === 0) return actionError(ADMINS_ONLY)
  }
  refresh(integrationId)
  return actionSuccess(`${found.action.title}: saved.`)
}

export type ActionRunState =
  | { status: 'idle' }
  | { status: 'error'; message: string; issues?: { path: string; message: string }[] }
  | {
      status: 'done'
      outcome: 'succeeded' | 'awaiting_approval' | 'denied' | 'failed' | 'duplicate'
      message: string
      executionId: string
      output?: unknown
      error?: NormalizedError
    }

export async function runIntegrationAction(_previous: ActionRunState, formData: FormData): Promise<ActionRunState> {
  const organizationId = readUuid(formData.get('organizationId'))
  const integrationId = readUuid(formData.get('integrationId'))
  const idempotencyKey = readUuid(formData.get('idempotencyKey'))
  const actionKey = formData.get('actionKey')
  const rawInput = formData.get('input')
  if (!organizationId || !integrationId || !idempotencyKey || typeof actionKey !== 'string') return { status: 'error', message: NOT_ALLOWED }
  if (typeof rawInput !== 'string' || rawInput.length > MAX_INPUT_BYTES) return { status: 'error', message: 'The input must be JSON of at most 20 KB.' }

  let input: unknown
  try {
    input = JSON.parse(rawInput)
  } catch {
    return { status: 'error', message: 'The input isn’t valid JSON.' }
  }

  const caller = await member(organizationId, MIN_ROLE_TO_RUN_ACTIONS)
  if (!caller.ok) return { status: 'error', message: caller.state.status === 'error' ? caller.state.message : NOT_ALLOWED }
  if (!runLimiter(caller.user.id)) return { status: 'error', message: 'Too many actions in a short time. Wait a minute and try again.' }
  const runtime = runtimeOrNull()
  if (!runtime) return { status: 'error', message: NOT_CONFIGURED }

  const result = await requestAction(runtime, {
    organizationId,
    integrationId,
    actionKey,
    input,
    idempotencyKey: `console:${idempotencyKey}`,
    actor: { kind: 'user', userId: caller.user.id, role: caller.role },
  })
  refresh(integrationId)

  switch (result.status) {
    case 'invalid_input':
      return { status: 'error', message: 'The input doesn’t match what this action accepts.', issues: result.issues }
    case 'refused':
      return { status: 'error', message: result.error.message }
    case 'succeeded':
      return { status: 'done', outcome: 'succeeded', message: 'The action ran successfully.', executionId: result.executionId, output: result.output }
    case 'awaiting_approval':
      return {
        status: 'done',
        outcome: 'awaiting_approval',
        message: 'This action needs approval. It will run after an admin approves it in Approvals.',
        executionId: result.executionId,
      }
    case 'denied':
      return { status: 'done', outcome: 'denied', message: `Blocked: ${result.reason}`, executionId: result.executionId }
    case 'failed':
      return { status: 'done', outcome: 'failed', message: result.error.message, executionId: result.executionId, error: result.error }
    case 'duplicate':
      return {
        status: 'done',
        outcome: 'duplicate',
        message: `This request was already submitted (status: ${result.executionStatus}).`,
        executionId: result.executionId,
        output: result.output,
      }
  }
}

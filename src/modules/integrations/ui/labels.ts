// Display text for connection health and OAuth callback results. Pure.

import type { StatusTone } from '@/lib/status'

import type { HealthStatus } from '../domain/types'

export const HEALTH_DISPLAY: Record<HealthStatus, { label: string; tone: StatusTone }> = {
  unknown: { label: 'Not checked', tone: 'neutral' },
  healthy: { label: 'Healthy', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  unhealthy: { label: 'Unhealthy', tone: 'danger' },
}

const CONNECT_ERRORS: Record<string, string> = {
  not_configured: 'This integration isn’t set up on this deployment yet.',
  denied: 'The connection was cancelled on the provider’s consent screen.',
  invalid_request: 'The provider’s response was incomplete. Please try again.',
  invalid_state: 'This connection link expired or was already used. Start again.',
  not_allowed: 'Only admins and owners of the workspace can connect integrations.',
  different_account: 'You authorized a different account than the one this connection uses. Connect it as a new connection instead.',
  exchange_failed: 'The provider didn’t complete the connection. Please try again.',
  save_failed: 'The connection couldn’t be saved. Please try again.',
}

export function connectErrorMessage(code: string | undefined): string | null {
  if (!code) return null
  return CONNECT_ERRORS[code] ?? 'The connection couldn’t be completed. Please try again.'
}

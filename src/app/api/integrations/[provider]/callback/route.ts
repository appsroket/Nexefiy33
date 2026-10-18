// OAuth redirect target registered with each provider
// ({APP_URL}/api/integrations/<provider>/callback). Verifies the signed-in
// user, checks they are still an admin of the workspace the flow was started
// for, then hands the one-time code and state to completeAuthorization.
// Never logs the code, the state or tokens.

import { NextResponse, type NextRequest } from 'next/server'

import { redact } from '@/lib/logging/redact'
import { hasMinRole } from '@/lib/supabase/types'
import { getConnector } from '@/modules/integrations/connectors/registry'
import { MIN_ROLE_TO_MANAGE_INTEGRATIONS } from '@/modules/integrations/domain/policy'
import { getVerifiedMember } from '@/modules/integrations/server/membership'
import { AuthorizationError, completeAuthorization, peekState } from '@/modules/integrations/server/oauth'
import { getIntegrationRuntime, isConnectorConfigured } from '@/modules/integrations/server/runtime'
import { createUserClient } from '@/lib/supabase/server'
import { getVerifiedUser } from '@/modules/identity/server/session'

export const dynamic = 'force-dynamic'

function back(request: NextRequest, path: string, params: Record<string, string>) {
  const url = new URL(path, request.nextUrl.origin)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return NextResponse.redirect(url, { status: 303 })
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  const connector = getConnector(provider)
  if (!connector) return NextResponse.json({ error: 'Unknown provider' }, { status: 404 })
  if (!isConnectorConfigured(connector)) return back(request, '/app/integrations', { connect_error: 'not_configured', provider })

  const search = request.nextUrl.searchParams
  // The person declined (or the provider refused) on the consent screen.
  if (search.get('error')) return back(request, '/app/integrations', { connect_error: 'denied', provider })

  const code = search.get('code')
  const state = search.get('state')
  if (!code || !state || code.length > 2048 || state.length > 256) {
    return back(request, '/app/integrations', { connect_error: 'invalid_request', provider })
  }

  const user = await getVerifiedUser(await createUserClient())
  if (!user) return back(request, '/sign-in', { next: '/app/integrations' })

  const runtime = getIntegrationRuntime()
  const organizationId = await peekState(runtime, connector, state, user.id)
  if (!organizationId) return back(request, '/app/integrations', { connect_error: 'invalid_state', provider })
  const membership = await getVerifiedMember(organizationId)
  if (membership.status !== 'ok' || !hasMinRole(membership.role, MIN_ROLE_TO_MANAGE_INTEGRATIONS)) {
    return back(request, '/app/integrations', { connect_error: 'not_allowed', provider })
  }

  try {
    const result = await completeAuthorization(runtime, connector, { state, code, userId: user.id })
    const destination = result.returnPath === '/app/integrations' ? `/app/integrations/${result.integrationId}` : result.returnPath
    return back(request, destination, { connected: provider })
  } catch (error) {
    if (error instanceof AuthorizationError) return back(request, '/app/integrations', { connect_error: error.reason, provider })
    console.error('[integrations] OAuth callback failed', redact(error))
    return back(request, '/app/integrations', { connect_error: 'save_failed', provider })
  }
}

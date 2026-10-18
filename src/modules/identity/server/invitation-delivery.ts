// Invitation emails. Sent through Resend when the email feature is
// configured; otherwise the person inviting gets the link to share themselves.
// The token is part of the link, so the email body and link are never logged.

import 'server-only'

import { sendPlainTextEmail, singleLine, type PlainTextEmail } from '@/lib/email/resend'
import { formatDateTime } from '@/lib/format'
import { getServerEnv } from '@/lib/env/server'
import type { OrganizationRole } from '@/lib/supabase/types'
import { roleLabel } from '@/modules/app-shell/domain/workspace'

import { invitationLink } from '../domain/invitations'

export interface InvitationMessage {
  to: string
  token: string
  organizationName: string
  inviterName: string
  role: OrganizationRole
  expiresAt: string
}

export type InvitationDelivery = 'sent' | 'not_configured' | 'failed'

export function buildInvitationEmail(message: InvitationMessage, config: { from: string; appUrl: string }): PlainTextEmail {
  const workspace = singleLine(message.organizationName)
  const inviter = singleLine(message.inviterName)
  const link = invitationLink(config.appUrl, message.token)
  return {
    from: config.from,
    to: [message.to],
    subject: `${inviter} invited you to ${workspace} on Nexefiy`,
    text: [
      `${inviter} invited you to join the workspace “${workspace}” on Nexefiy as ${roleLabel(message.role).toLowerCase()}.`,
      '',
      `Accept the invitation: ${link}`,
      '',
      `Sign in or create an account with this email address (${message.to}) to accept.`,
      `The invitation expires on ${formatDateTime(message.expiresAt, { timeZone: 'UTC' })} UTC and works once.`,
      '',
      'If you weren’t expecting this, you can ignore this email.',
    ].join('\n'),
  }
}

export async function deliverInvitation(message: InvitationMessage): Promise<InvitationDelivery> {
  const env = getServerEnv()
  if (!env.email) return 'not_configured'
  const result = await sendPlainTextEmail(
    env.email.resendApiKey,
    buildInvitationEmail(message, { from: env.email.from, appUrl: env.core.appUrl }),
  )
  if (result.ok) return 'sent'
  console.error(
    '[identity] invitation email failed',
    result.reason === 'rejected' ? { status: result.status } : { error: result.errorName },
  )
  return 'failed'
}

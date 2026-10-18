// Invitations: display status and the link format.
//
// The link carries the one-time token in the URL fragment (/invite#<token>).
// Browsers never send fragments to servers, so the token stays out of server
// and proxy request logs and out of Referer headers; the invitation page reads
// it in the browser and passes it to a Server Action in the request body.

import type { InvitableRole } from './members'

/** Tokens are 32 random bytes in hex (see public.create_invitation). */
export const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/

export const INVITATION_LIFETIME_DAYS = 7

/** Browser storage key that keeps a token while the invitee signs in or signs up. */
export const PENDING_INVITATION_STORAGE_KEY = 'nxf_pending_invitation'

export const INVITABLE_ROLES = ['admin', 'operator', 'viewer'] as const satisfies readonly InvitableRole[]

export function isInvitationToken(value: unknown): value is string {
  return typeof value === 'string' && INVITATION_TOKEN_PATTERN.test(value)
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

/** A pending invitation past its expiry is shown, and treated, as expired. */
export function effectiveInvitationStatus(status: string, expiresAt: string, now: Date = new Date()): InvitationStatus {
  if (status === 'pending' && new Date(expiresAt).getTime() <= now.getTime()) return 'expired'
  if (status === 'accepted' || status === 'revoked' || status === 'expired') return status
  return 'pending'
}

export function invitationLink(appUrl: string, token: string): string {
  return new URL(`/invite#${token}`, appUrl).toString()
}

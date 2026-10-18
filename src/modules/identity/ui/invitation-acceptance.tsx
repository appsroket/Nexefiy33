'use client'

// The invitation page. The token arrives in the URL fragment (/invite#token),
// which browsers never send to the server. It is kept in this browser's local
// storage while the person signs in or creates an account (the confirmation
// email may open a new tab), removed from the address bar, and deleted once
// the invitation is used or turns out to be invalid.

import { CircleAlert, MailWarning, Users } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useSyncExternalStore, useTransition, type ReactNode } from 'react'

import { DateTime } from '@/components/date-time'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { roleLabel } from '@/modules/app-shell/domain/workspace'

import { AUTH_PATHS } from '../domain/auth'
import { INVITATION_LIFETIME_DAYS, isInvitationToken, PENDING_INVITATION_STORAGE_KEY } from '../domain/invitations'
import { switchAccount } from '../server/auth-actions'
import { acceptInvitation, lookupInvitation, type InvitationLookup } from '../server/invitation-actions'

const MAX_STORED_MS = INVITATION_LIFETIME_DAYS * 24 * 60 * 60 * 1000

function readStoredToken(): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(PENDING_INVITATION_STORAGE_KEY) ?? 'null') as {
      token?: unknown
      savedAt?: unknown
    } | null
    if (stored && isInvitationToken(stored.token) && typeof stored.savedAt === 'number' && Date.now() - stored.savedAt < MAX_STORED_MS) {
      return stored.token
    }
  } catch {
    // Storage blocked or unreadable: the person can open the link again.
  }
  return null
}

function storeToken(token: string) {
  try {
    localStorage.setItem(PENDING_INVITATION_STORAGE_KEY, JSON.stringify({ token, savedAt: Date.now() }))
  } catch {
    // Without storage the link still works in this tab.
  }
}

function forgetToken() {
  try {
    localStorage.removeItem(PENDING_INVITATION_STORAGE_KEY)
  } catch {
    // Nothing to clean up.
  }
}

/** The token from the link's fragment, else one kept from an earlier visit. */
function currentToken(): string | null {
  const fromLink = window.location.hash.slice(1)
  return isInvitationToken(fromLink) ? fromLink : readStoredToken()
}

/** Re-read when only the fragment changes (an invitation link opened from this page). */
function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

export function InvitationAcceptance() {
  const router = useRouter()
  // undefined while rendering on the server (the fragment only exists in the browser).
  const token = useSyncExternalStore(subscribeToHash, currentToken, () => undefined)
  const [result, setResult] = useState<{ token: string; lookup: InvitationLookup } | null>(null)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!token) return
    storeToken(token)
    // Keep the token out of the address bar, history and screenshots.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
    lookupInvitation(token).then(
      (lookup) => {
        if (lookup.status === 'not_found') forgetToken()
        setResult({ token, lookup })
      },
      () => setResult({ token, lookup: { status: 'error' } }),
    )
  }, [token])

  function accept(token: string) {
    setAcceptError(null)
    startTransition(async () => {
      const result = await acceptInvitation(token)
      if (result.status === 'success' || (result.status === 'error' && result.code === 'already_member')) {
        forgetToken()
        router.push('/app')
        router.refresh()
        return
      }
      if (result.status === 'error') setAcceptError(result.message)
    })
  }

  if (!result && token === null) {
    return (
      <Message
        title="No invitation found"
        body="Open the invitation link from your email again. If it still doesn’t work, ask the person who invited you to send a new invitation."
        action={<Link href="/app">Go to Nexefiy</Link>}
      />
    )
  }

  if (!result) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" /> Checking your invitation…
      </p>
    )
  }

  const { lookup } = result

  if (lookup.status === 'signed_out') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-pretty">
          Sign in, or create an account, with the email address the invitation was sent to. You’ll come back here to
          accept it.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild className="sm:flex-1">
            <Link href={`${AUTH_PATHS.signIn}?next=${AUTH_PATHS.invite}`}>Sign in</Link>
          </Button>
          <Button asChild variant="outline" className="sm:flex-1">
            <Link href={`${AUTH_PATHS.signUp}?next=${AUTH_PATHS.invite}`}>Create an account</Link>
          </Button>
        </div>
      </div>
    )
  }

  if (lookup.status === 'not_found') {
    return (
      <Message
        title="This invitation link isn’t valid"
        body="Make sure you opened the complete link from the email. If it still doesn’t work, ask for a new invitation."
        action={<Link href="/app">Go to Nexefiy</Link>}
      />
    )
  }

  if (lookup.status === 'error') {
    return (
      <Message
        title="We couldn’t check this invitation"
        body="Something went wrong on our side. Please reload the page in a moment."
      />
    )
  }

  const { invitation, signedInEmail } = lookup
  const workspace = invitation.organizationName

  if (invitation.alreadyMember) {
    return (
      <Message
        title={`You’re already a member of ${workspace}`}
        action={
          <Link href="/app" onClick={forgetToken}>
            Go to the workspace
          </Link>
        }
      />
    )
  }

  if (invitation.status !== 'pending') {
    const reasons = {
      expired: `This invitation to ${workspace} has expired. Ask the person who invited you to send a new one.`,
      revoked: `This invitation to ${workspace} was withdrawn.`,
      accepted: `This invitation to ${workspace} has already been used.`,
    } as const
    return (
      <Message
        title="This invitation can’t be used"
        body={reasons[invitation.status]}
        action={
          <Link href="/app" onClick={forgetToken}>
            Go to Nexefiy
          </Link>
        }
      />
    )
  }

  if (!invitation.emailMatches) {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <MailWarning aria-hidden="true" />
          <AlertTitle>This invitation is for a different email address</AlertTitle>
          <AlertDescription>
            It was sent to {invitation.invitedEmail}, but you’re signed in as {signedInEmail ?? 'another account'}. Sign
            in with {invitation.invitedEmail} to accept it.
          </AlertDescription>
        </Alert>
        <form action={switchAccount}>
          <Button type="submit" variant="outline">
            Sign out and use another account
          </Button>
        </form>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
        <Users aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-1 text-sm">
          <p>
            You’ve been invited to join <strong className="font-semibold">{workspace}</strong> as{' '}
            <strong className="font-semibold">{roleLabel(invitation.role).toLowerCase()}</strong>.
          </p>
          <p className="text-muted-foreground">
            Expires <DateTime value={invitation.expiresAt} />.
          </p>
        </div>
      </div>
      {acceptError ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{acceptError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={() => accept(result.token)} disabled={pending} className="sm:flex-1">
          {pending ? (
            <>
              <Spinner data-icon="inline-start" aria-hidden="true" /> Joining…
            </>
          ) : (
            `Join ${workspace}`
          )}
        </Button>
        <Button asChild variant="outline" className="sm:flex-1">
          <Link href="/app">Not now</Link>
        </Button>
      </div>
    </div>
  )
}

function Message({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">{title}</h2>
        {body ? <p className="text-pretty text-sm text-muted-foreground">{body}</p> : null}
      </div>
      {action ? (
        <div>
          <Button asChild variant="outline">
            {action}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

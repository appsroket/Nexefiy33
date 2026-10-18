'use client'

// Inviting people, and the list of open invitations. When email isn't set up
// (or sending fails) the person inviting gets the link once, to share
// themselves; it isn't stored anywhere and can't be shown again.

import { Check, Copy, MailPlus, RotateCw, X } from 'lucide-react'
import { useState, useTransition } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DateTime } from '@/components/date-time'
import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { SelectField, TextField } from '@/components/forms/text-field'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ActionState } from '@/lib/forms/action-state'
import type { OrganizationRole } from '@/lib/supabase/types'
import { roleLabel } from '@/modules/app-shell/domain/workspace'

import type { InvitationStatus } from '../domain/invitations'
import { ROLE_DESCRIPTIONS, type InvitableRole } from '../domain/members'
import { inviteMember, resendInvitation, revokeInvitation } from '../server/member-actions'

export interface InvitationView {
  id: string
  email: string
  role: OrganizationRole
  status: InvitationStatus
  expiresAt: string
}

interface SharedLink {
  link: string
  message: string
}

function sharedLinkFrom(state: ActionState): SharedLink | null {
  return state.status === 'success' && state.data?.link ? { link: state.data.link, message: state.message ?? '' } : null
}

export function InviteDialog({ organizationId, roles }: { organizationId: string; roles: readonly InvitableRole[] }) {
  const [open, setOpen] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [shared, setShared] = useState<SharedLink | null>(null)
  const [sentMessage, setSentMessage] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InvitableRole>(roles.includes('operator') ? 'operator' : (roles[0] ?? 'viewer'))

  return (
    <div className="flex flex-col items-end gap-2">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) {
            setFormKey((key) => key + 1)
            setShared(null)
            setSentMessage(null)
            setEmail('')
          }
        }}
      >
        <DialogTrigger asChild>
          <Button>
            <MailPlus data-icon="inline-start" aria-hidden="true" />
            Invite people
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          {shared ? (
            <ShareLinkContent shared={shared} />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Invite someone</DialogTitle>
                <DialogDescription>
                  They’ll need to sign in or create an account with this email address to join.
                </DialogDescription>
              </DialogHeader>
              <ActionForm
                key={formKey}
                action={inviteMember}
                aria-label="Invite someone"
                className="flex flex-col gap-4"
                onSuccess={(state) => {
                  const link = sharedLinkFrom(state)
                  if (link) {
                    setShared(link)
                  } else {
                    setSentMessage(state.status === 'success' ? (state.message ?? null) : null)
                    setOpen(false)
                  }
                }}
              >
                <FormMessage />
                <input type="hidden" name="organizationId" value={organizationId} />
                <FieldGroup>
                  <TextField
                    name="email"
                    label="Email address"
                    type="email"
                    autoComplete="off"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <SelectField
                    name="role"
                    label="Role"
                    value={role}
                    onChange={(event) => setRole(event.target.value as InvitableRole)}
                    options={roles.map((value) => ({ value, label: roleLabel(value) }))}
                    description={ROLE_DESCRIPTIONS[role]}
                  />
                </FieldGroup>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  </DialogClose>
                  <SubmitButton pendingLabel="Inviting…">Send invitation</SubmitButton>
                </DialogFooter>
              </ActionForm>
            </>
          )}
        </DialogContent>
      </Dialog>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
        {sentMessage}
      </p>
    </div>
  )
}

function ShareLinkContent({ shared }: { shared: SharedLink }) {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Share the invitation link</DialogTitle>
        <DialogDescription>{shared.message}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <label htmlFor="invitation-link" className="text-sm font-medium">
          Invitation link
        </label>
        <div className="flex gap-2">
          <Input id="invitation-link" readOnly value={shared.link} onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shared.link)
                setCopied(true)
              } catch {
                setCopied(false)
              }
            }}
          >
            {copied ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Anyone with this link can see the invitation, but only the invited email address can accept it. It’s shown
          only now; to get a new one, resend the invitation.
        </p>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button">Done</Button>
        </DialogClose>
      </DialogFooter>
    </>
  )
}

export function InvitationsTable({ organizationId, invitations }: { organizationId: string; invitations: readonly InvitationView[] }) {
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [shared, setShared] = useState<SharedLink | null>(null)

  if (invitations.length === 0) {
    return <p className="text-sm text-muted-foreground">No open invitations.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
        {notice}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead className="w-28">Role</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="hidden w-48 md:table-cell">Expires</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                organizationId={organizationId}
                invitation={invitation}
                onError={setError}
                onNotice={setNotice}
                onShare={setShared}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={shared !== null} onOpenChange={(next) => (next ? null : setShared(null))}>
        <DialogContent className="sm:max-w-lg">{shared ? <ShareLinkContent shared={shared} /> : null}</DialogContent>
      </Dialog>
    </div>
  )
}

function InvitationRow({
  organizationId,
  invitation,
  onError,
  onNotice,
  onShare,
}: {
  organizationId: string
  invitation: InvitationView
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
  onShare: (shared: SharedLink) => void
}) {
  const [pending, startTransition] = useTransition()

  function resend() {
    onError(null)
    onNotice(null)
    startTransition(async () => {
      const result = await resendInvitation(organizationId, invitation.id)
      if (result.status === 'error') return onError(result.message)
      const link = sharedLinkFrom(result)
      if (link) onShare(link)
      else if (result.status === 'success') onNotice(result.message ?? null)
    })
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{invitation.email}</TableCell>
      <TableCell>{roleLabel(invitation.role)}</TableCell>
      <TableCell>
        <StatusBadge kind="invitation" status={invitation.status} />
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">
        <DateTime value={invitation.expiresAt} />
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" onClick={resend} disabled={pending} aria-label={`Resend invitation to ${invitation.email}`}>
            <RotateCw aria-hidden="true" className={pending ? 'animate-spin' : undefined} />
          </Button>
          {invitation.status === 'pending' ? (
            <ConfirmDialog
              trigger={
                <Button variant="ghost" size="icon" aria-label={`Revoke invitation to ${invitation.email}`}>
                  <X aria-hidden="true" />
                </Button>
              }
              title={`Revoke the invitation to ${invitation.email}?`}
              description="The link stops working immediately. You can invite them again later."
              confirmLabel="Revoke"
              pendingLabel="Revoking…"
              destructive
              onConfirm={() => revokeInvitation(organizationId, invitation.id)}
            />
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

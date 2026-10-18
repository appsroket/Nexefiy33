'use client'

// Workspace members: role changes and removal. Which controls appear follows
// memberPermissions() (a mirror of the database rules); the database makes
// the actual decision when the change is saved.

import { CircleAlert, UserMinus } from 'lucide-react'
import { useState, useTransition } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DateTime } from '@/components/date-time'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { OrganizationRole } from '@/lib/supabase/types'
import { roleLabel } from '@/modules/app-shell/domain/workspace'

import { memberPermissions, type MemberRef } from '../domain/members'
import { changeMemberRole, removeMember } from '../server/member-actions'

export interface MemberView {
  userId: string
  name: string | null
  email: string | null
  role: OrganizationRole
  joinedAt: string
}

export function MembersPanel({
  organizationId,
  members,
  actor,
}: {
  organizationId: string
  members: readonly MemberView[]
  actor: MemberRef
}) {
  const ownerCount = members.filter((member) => member.role === 'owner').length
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead className="w-44">Role</TableHead>
              <TableHead className="hidden w-48 md:table-cell">Joined</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <MemberRow
                key={member.userId}
                organizationId={organizationId}
                member={member}
                actor={actor}
                ownerCount={ownerCount}
                onError={setError}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function MemberRow({
  organizationId,
  member,
  actor,
  ownerCount,
  onError,
}: {
  organizationId: string
  member: MemberView
  actor: MemberRef
  ownerCount: number
  onError: (message: string | null) => void
}) {
  const [pending, startTransition] = useTransition()
  const isYou = member.userId === actor.userId
  const permissions = memberPermissions(actor, member, ownerCount)
  const label = member.name ?? member.email ?? 'Unnamed member'

  function changeRole(role: string) {
    onError(null)
    startTransition(async () => {
      const result = await changeMemberRole(organizationId, member.userId, role)
      if (result.status === 'error') onError(result.message)
    })
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 font-medium">
            <span className="truncate">{label}</span>
            {isYou ? <Badge variant="secondary">You</Badge> : null}
          </span>
          {member.name && member.email ? <span className="truncate text-xs text-muted-foreground">{member.email}</span> : null}
        </div>
      </TableCell>
      <TableCell>
        {permissions.roleOptions.length > 0 ? (
          <span className="flex items-center gap-2">
            <select
              aria-label={`Role for ${label}`}
              value={member.role}
              disabled={pending}
              onChange={(event) => changeRole(event.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {permissions.roleOptions.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </select>
            {pending ? <Spinner aria-label="Saving role" /> : null}
          </span>
        ) : (
          <span>{roleLabel(member.role)}</span>
        )}
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">
        <DateTime value={member.joinedAt} />
      </TableCell>
      <TableCell>
        {permissions.canRemove ? (
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="icon" aria-label={`Remove ${label}`}>
                <UserMinus aria-hidden="true" />
              </Button>
            }
            title={`Remove ${label}?`}
            description="They lose access to this workspace immediately. You can invite them again later."
            confirmLabel="Remove"
            pendingLabel="Removing…"
            destructive
            onConfirm={() => removeMember(organizationId, member.userId)}
          />
        ) : null}
      </TableCell>
    </TableRow>
  )
}

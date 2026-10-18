'use client'

// Workspace forms. Controls are shown only to roles that can use them, but
// every change is authorized by the database, not by what is shown here.

import { LogOut, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ActionForm, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { FormDialog } from '@/components/forms/form-dialog'
import { SelectField, TextAreaField, TextField } from '@/components/forms/text-field'
import { Button } from '@/components/ui/button'
import { FieldGroup } from '@/components/ui/field'

import { SLUG_MAX_LENGTH, slugify, WORKSPACE_NAME_MAX_LENGTH } from '../domain/workspace'
import {
  createWorkspace,
  deleteWorkspace,
  leaveWorkspace,
  updateCompanyDetails,
  updateWorkspace,
} from '../server/workspace-actions'

const SLUG_HINT = 'Lowercase letters, numbers and dashes. It identifies the workspace and must be unique.'

export function CreateWorkspaceForm() {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)

  return (
    <ActionForm action={createWorkspace} aria-label="Create a workspace" className="flex max-w-lg flex-col gap-4">
      <FormMessage />
      <FieldGroup>
        <TextField
          name="name"
          label="Workspace name"
          description="Usually your company or team name."
          autoComplete="organization"
          required
          maxLength={WORKSPACE_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            if (!slugEdited) setSlug(slugify(event.target.value))
          }}
        />
        <TextField
          name="slug"
          label="Workspace address"
          description={SLUG_HINT}
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={SLUG_MAX_LENGTH}
          value={slug}
          onChange={(event) => {
            setSlugEdited(true)
            setSlug(event.target.value.toLowerCase())
          }}
        />
      </FieldGroup>
      <div>
        <SubmitButton pendingLabel="Creating…">Create workspace</SubmitButton>
      </div>
    </ActionForm>
  )
}

export function WorkspaceDetailsForm({
  organizationId,
  name: initialName,
  slug: initialSlug,
}: {
  organizationId: string
  name: string
  slug: string
}) {
  const [values, setValues] = useState({ name: initialName, slug: initialSlug })
  return (
    <ActionForm action={updateWorkspace} aria-label="Workspace details" className="flex max-w-lg flex-col gap-4">
      <FormMessage />
      <input type="hidden" name="organizationId" value={organizationId} />
      <FieldGroup>
        <TextField
          name="name"
          label="Workspace name"
          required
          maxLength={WORKSPACE_NAME_MAX_LENGTH}
          value={values.name}
          onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
        />
        <TextField
          name="slug"
          label="Workspace address"
          description={SLUG_HINT}
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={SLUG_MAX_LENGTH}
          value={values.slug}
          onChange={(event) => setValues((current) => ({ ...current, slug: event.target.value.toLowerCase() }))}
        />
      </FieldGroup>
      <div>
        <SubmitButton>Save workspace</SubmitButton>
      </div>
    </ActionForm>
  )
}

export interface CompanyDetailsValues {
  legalName: string
  industry: string
  website: string
  description: string
  timezone: string
}

export function CompanyDetailsForm({
  organizationId,
  initial,
  timeZones,
}: {
  organizationId: string
  initial: CompanyDetailsValues
  timeZones: readonly string[]
}) {
  const [values, setValues] = useState(initial)
  const bind = (key: keyof CompanyDetailsValues) => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) => setValues((current) => ({ ...current, [key]: event.target.value })),
  })
  const zones = timeZones.includes(values.timezone) ? timeZones : [values.timezone, ...timeZones]

  return (
    <ActionForm action={updateCompanyDetails} aria-label="Company details" className="flex max-w-2xl flex-col gap-4">
      <FormMessage />
      <input type="hidden" name="organizationId" value={organizationId} />
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="legalName" label="Legal company name" autoComplete="organization" maxLength={200} {...bind('legalName')} />
          <TextField name="industry" label="Industry" maxLength={100} {...bind('industry')} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="website" label="Website" inputMode="url" autoComplete="url" placeholder="example.com" maxLength={500} {...bind('website')} />
          <SelectField
            name="timezone"
            label="Time zone"
            options={zones.map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }))}
            {...bind('timezone')}
          />
        </div>
        <TextAreaField
          name="description"
          label="What your company does"
          description="A few sentences in plain language. Later, AI employees will use this as background."
          maxLength={5000}
          rows={4}
          {...bind('description')}
        />
      </FieldGroup>
      <div>
        <SubmitButton>Save company details</SubmitButton>
      </div>
    </ActionForm>
  )
}

export function LeaveWorkspaceButton({ organizationId, name }: { organizationId: string; name: string }) {
  const router = useRouter()
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline">
          <LogOut data-icon="inline-start" aria-hidden="true" />
          Leave workspace
        </Button>
      }
      title={`Leave ${name}?`}
      description="You’ll lose access to this workspace straight away. To come back, someone will need to invite you again."
      confirmLabel="Leave workspace"
      pendingLabel="Leaving…"
      destructive
      onConfirm={async () => {
        const result = await leaveWorkspace(organizationId)
        if (result.status === 'success') {
          router.push('/app')
          router.refresh()
        }
        return result
      }}
    />
  )
}

export function DeleteWorkspaceButton({ organizationId, name, slug }: { organizationId: string; name: string; slug: string }) {
  return (
    <FormDialog
      trigger={
        <Button variant="destructive">
          <Trash2 data-icon="inline-start" aria-hidden="true" />
          Delete workspace
        </Button>
      }
      title={`Delete ${name}?`}
      description="This permanently deletes the workspace and everything in it for every member. It can’t be undone. The audit log keeps a record that it happened."
      action={deleteWorkspace}
      submitLabel="Delete permanently"
      pendingLabel="Deleting…"
    >
      <input type="hidden" name="organizationId" value={organizationId} />
      <TextField
        name="confirmation"
        label={`Type ${slug} to confirm`}
        autoComplete="off"
        spellCheck={false}
        required
      />
    </FormDialog>
  )
}

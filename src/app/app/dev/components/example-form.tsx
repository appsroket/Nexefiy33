'use client'

import { ActionForm, FieldErrors, FormMessage, SubmitButton, useFieldA11y } from '@/components/forms/action-form'
import { FormDialog } from '@/components/forms/form-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

import { exampleFormAction } from './actions'

function NameField() {
  const a11y = useFieldA11y('name')
  return (
    <Field data-invalid={a11y['aria-invalid'] || undefined}>
      <FieldLabel htmlFor="example-name">Full name</FieldLabel>
      <Input id="example-name" name="name" autoComplete="off" {...a11y} />
      <FieldErrors name="name" />
    </Field>
  )
}

function EmailField() {
  const a11y = useFieldA11y('email')
  return (
    <Field data-invalid={a11y['aria-invalid'] || undefined}>
      <FieldLabel htmlFor="example-email">Email</FieldLabel>
      <Input id="example-email" name="email" type="email" autoComplete="off" {...a11y} />
      <FieldDescription>Validation runs on the server; nothing is sent or saved.</FieldDescription>
      <FieldErrors name="email" />
    </Field>
  )
}

export function ExampleInlineForm() {
  return (
    <ActionForm action={exampleFormAction} aria-label="Example form" className="flex max-w-md flex-col gap-4">
      <FormMessage />
      <FieldGroup>
        <NameField />
        <EmailField />
      </FieldGroup>
      <div>
        <SubmitButton pendingLabel="Checking…">Check example</SubmitButton>
      </div>
    </ActionForm>
  )
}

export function ExampleFormDialog() {
  return (
    <FormDialog
      trigger={<Button variant="outline">Open form dialog</Button>}
      title="Example form dialog"
      description="Closes itself when the server accepts the input."
      action={exampleFormAction}
      submitLabel="Check example"
      pendingLabel="Checking…"
    >
      <FieldGroup>
        <NameField />
        <EmailField />
      </FieldGroup>
    </FormDialog>
  )
}

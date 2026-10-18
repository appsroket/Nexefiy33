'use client'

import type { ComponentProps, ReactNode } from 'react'

import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

import { FieldErrors, useFieldA11y } from './action-form'

type InputProps = Omit<ComponentProps<typeof Input>, 'name' | 'id'>

/**
 * A labelled input inside an ActionForm: shows the server's field errors for
 * `name` and wires aria-invalid / aria-describedby. Pass `value` and
 * `onChange` to keep what was typed after a failed submission (React resets
 * uncontrolled fields when a form action finishes).
 */
export function TextField({
  name,
  label,
  description,
  labelAction,
  ...inputProps
}: InputProps & { name: string; label: string; description?: ReactNode; labelAction?: ReactNode }) {
  const a11y = useFieldA11y(name)
  const id = `field-${name}`
  const describedBy = [a11y['aria-describedby'], description ? `${id}-description` : undefined].filter(Boolean).join(' ')
  return (
    <Field data-invalid={a11y['aria-invalid'] || undefined}>
      {labelAction ? (
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          {labelAction}
        </div>
      ) : (
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      )}
      <Input id={id} name={name} {...inputProps} aria-invalid={a11y['aria-invalid']} aria-describedby={describedBy || undefined} />
      {description ? <FieldDescription id={`${id}-description`}>{description}</FieldDescription> : null}
      <FieldErrors name={name} />
    </Field>
  )
}

type TextareaProps = Omit<ComponentProps<typeof Textarea>, 'name' | 'id'>

export function TextAreaField({
  name,
  label,
  description,
  ...textareaProps
}: TextareaProps & { name: string; label: string; description?: ReactNode }) {
  const a11y = useFieldA11y(name)
  const id = `field-${name}`
  const describedBy = [a11y['aria-describedby'], description ? `${id}-description` : undefined].filter(Boolean).join(' ')
  return (
    <Field data-invalid={a11y['aria-invalid'] || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        name={name}
        {...textareaProps}
        aria-invalid={a11y['aria-invalid']}
        aria-describedby={describedBy || undefined}
      />
      {description ? <FieldDescription id={`${id}-description`}>{description}</FieldDescription> : null}
      <FieldErrors name={name} />
    </Field>
  )
}

/** A native select (accessible on every device) with the same error wiring. */
export function SelectField({
  name,
  label,
  description,
  options,
  ...selectProps
}: Omit<ComponentProps<'select'>, 'name' | 'id'> & {
  name: string
  label: string
  description?: ReactNode
  options: readonly { value: string; label: string }[]
}) {
  const a11y = useFieldA11y(name)
  const id = `field-${name}`
  const describedBy = [a11y['aria-describedby'], description ? `${id}-description` : undefined].filter(Boolean).join(' ')
  return (
    <Field data-invalid={a11y['aria-invalid'] || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        name={name}
        {...selectProps}
        aria-invalid={a11y['aria-invalid']}
        aria-describedby={describedBy || undefined}
        className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {description ? <FieldDescription id={`${id}-description`}>{description}</FieldDescription> : null}
      <FieldErrors name={name} />
    </Field>
  )
}

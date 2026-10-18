'use client'

// Contact form. Fields are controlled so a server-side validation error never
// clears what the person typed; it works without JavaScript too.

import { CircleCheck } from 'lucide-react'
import Link from 'next/link'
import { useState, type ComponentProps } from 'react'

import { ActionForm, FieldErrors, FormMessage, SubmitButton, useFieldA11y } from '@/components/forms/action-form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ActionState } from '@/lib/forms/action-state'
import { cn } from '@/lib/utils'

import { CONTACT_LIMITS, CONTACT_TOPICS, HONEYPOT_FIELD, type ContactTopic } from '../domain/contact'
import { sendContactMessage } from '../server/actions'

type Values = { name: string; email: string; company: string; topic: ContactTopic | ''; message: string }

const EMPTY: Values = { name: '', email: '', company: '', topic: '', message: '' }

export function ContactForm({ available, initialTopic }: { available: boolean; initialTopic?: ContactTopic }) {
  const [values, setValues] = useState<Values>({ ...EMPTY, topic: initialTopic ?? '' })
  const [sent, setSent] = useState<string | null>(null)

  if (sent) {
    return (
      <div role="status" className="flex flex-col items-start gap-4">
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>Message sent</AlertTitle>
          <AlertDescription>{sent}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => setSent(null)}>
          Send another message
        </Button>
      </div>
    )
  }

  const update = (field: keyof Values) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [field]: event.target.value }))

  return (
    <ActionForm
      action={sendContactMessage}
      aria-label="Contact Nexefiy"
      className="flex flex-col gap-5"
      onSuccess={(state: ActionState) => {
        setValues({ ...EMPTY, topic: initialTopic ?? '' })
        setSent(state.status === 'success' ? (state.message ?? 'Thanks, your message was sent.') : null)
      }}
    >
      <FormMessage />
      {/* Disabled controls aren't submitted; the server refuses too while delivery isn't configured. */}
      <fieldset disabled={!available} className="flex flex-col gap-5 disabled:opacity-60">
        <legend className="sr-only">Your message</legend>
        <FieldGroup>
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField name="name" label="Name" autoComplete="name" value={values.name} onChange={update('name')} maxLength={CONTACT_LIMITS.name} required />
            <TextField name="email" label="Work email" type="email" autoComplete="email" value={values.email} onChange={update('email')} required />
          </div>
          <TextField
            name="company"
            label="Company"
            optional
            autoComplete="organization"
            value={values.company}
            onChange={update('company')}
            maxLength={CONTACT_LIMITS.company}
          />
          <TopicField value={values.topic} onChange={update('topic')} />
          <MessageField value={values.message} onChange={update('message')} />
        </FieldGroup>
        {/* Honeypot: hidden from people and assistive technology; bots tend to fill it. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor="contact-website">Leave this field empty</label>
          <input id="contact-website" name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
        <p className="text-sm text-muted-foreground">
          We use these details only to reply to you. See the draft{' '}
          <Link href="/legal/privacy" className="font-medium text-primary underline-offset-4 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
        <div>
          <SubmitButton pendingLabel="Sending…">Send message</SubmitButton>
        </div>
      </fieldset>
    </ActionForm>
  )
}

function TextField({
  name,
  label,
  optional = false,
  ...props
}: {
  name: string
  label: string
  optional?: boolean
} & Omit<ComponentProps<'input'>, 'name' | 'id'>) {
  const a11y = useFieldA11y(name)
  const id = `contact-${name}`
  return (
    <Field data-invalid={a11y['aria-invalid'] || undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </FieldLabel>
      <Input id={id} name={name} className="h-10" {...props} {...a11y} />
      <FieldErrors name={name} />
    </Field>
  )
}

function TopicField({ value, onChange }: { value: string; onChange: (event: { target: { value: string } }) => void }) {
  const a11y = useFieldA11y('topic')
  return (
    <Field data-invalid={a11y['aria-invalid'] || undefined}>
      <FieldLabel htmlFor="contact-topic">Topic</FieldLabel>
      {/* A native select: keyboard- and screen-reader-friendly, and works without JavaScript. */}
      <select
        id="contact-topic"
        name="topic"
        required
        value={value}
        onChange={onChange}
        className={cn(
          'h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30',
          value === '' && 'text-muted-foreground',
        )}
        {...a11y}
      >
        <option value="" disabled>
          Choose a topic
        </option>
        {CONTACT_TOPICS.map((topic) => (
          <option key={topic.value} value={topic.value} className="text-foreground">
            {topic.label}
          </option>
        ))}
      </select>
      <FieldErrors name="topic" />
    </Field>
  )
}

function MessageField({ value, onChange }: { value: string; onChange: (event: { target: { value: string } }) => void }) {
  const a11y = useFieldA11y('message')
  const describedBy = [a11y['aria-describedby'], 'contact-message-hint'].filter(Boolean).join(' ')
  return (
    <Field data-invalid={a11y['aria-invalid'] || undefined}>
      <FieldLabel htmlFor="contact-message">Message</FieldLabel>
      <Textarea
        id="contact-message"
        name="message"
        required
        rows={6}
        className="min-h-32"
        value={value}
        onChange={onChange}
        maxLength={CONTACT_LIMITS.message}
        aria-invalid={a11y['aria-invalid']}
        aria-describedby={describedBy}
      />
      <FieldDescription id="contact-message-hint">
        What does your business do, and what would you like AI employees to help with? Please don’t include passwords
        or other sensitive information.
      </FieldDescription>
      <FieldErrors name="message" />
    </Field>
  )
}

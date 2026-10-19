'use client'

// Creating a workflow, three ways: describe it in plain language (the AI
// model, or labelled keyword rules without one, drafts it), start from a
// template, or start blank and build it on the canvas or in the step forms.
// Every way saves a draft and opens the builder; nothing runs until an admin
// activates a version.

import { CircleAlert, LayoutTemplate, PencilRuler, Sparkles } from 'lucide-react'
import { useActionState, useState } from 'react'

import { SectionCard } from '@/components/cards'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { IDLE_ACTION_STATE } from '@/lib/forms/action-state'

import { createWorkflowAction } from '../server/actions'

const EXAMPLE =
  'When a new lead comes in, have the sales employee check whether it is a real business contact. If it is qualified, ask an admin to approve, then add the contact to HubSpot. If adding fails, end as failed.'

export function NewWorkflow({
  organizationId,
  templates,
  modelConfigured,
}: {
  organizationId: string
  templates: { key: string; name: string; summary: string }[]
  modelConfigured: boolean
}) {
  const [state, formAction, pending] = useActionState(createWorkflowAction, IDLE_ACTION_STATE)
  const [description, setDescription] = useState('')
  const error = state.status === 'error' ? state.message : null

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Tabs defaultValue="describe">
        <TabsList>
          <TabsTrigger value="describe">
            <Sparkles aria-hidden="true" />
            Describe it
          </TabsTrigger>
          <TabsTrigger value="template">
            <LayoutTemplate aria-hidden="true" />
            Template
          </TabsTrigger>
          <TabsTrigger value="blank">
            <PencilRuler aria-hidden="true" />
            Build it yourself
          </TabsTrigger>
        </TabsList>

        <TabsContent value="describe">
          <SectionCard
            title="Describe the workflow"
            description={
              modelConfigured
                ? 'The AI model drafts the workflow from your description using only the employees, actions and connections this workspace has. It is saved as a draft for you to review; it can’t run until an admin activates it.'
                : 'No AI model is configured on this deployment, so keyword rules draft it (and say so). Review and complete every step; it can’t run until an admin activates it.'
            }
          >
            <form action={formAction} className="flex flex-col gap-3">
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="mode" value="describe" />
              <Field>
                <FieldLabel htmlFor="workflow-description-input">What should happen, in order?</FieldLabel>
                <Textarea id="workflow-description-input" name="description" rows={5} maxLength={3000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={EXAMPLE} />
                <FieldDescription>
                  Mention who does what, which apps are involved, when a person must approve, and what happens when something fails.{' '}
                  <button type="button" className="underline underline-offset-4" onClick={() => setDescription(EXAMPLE)}>
                    Use the example
                  </button>
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="workflow-name-describe">Name (optional)</FieldLabel>
                <Input id="workflow-name-describe" name="name" maxLength={200} />
              </Field>
              <div>
                <Button type="submit" disabled={pending || description.trim().length < 15}>
                  {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Sparkles data-icon="inline-start" aria-hidden="true" />}
                  Draft the workflow
                </Button>
              </div>
            </form>
          </SectionCard>
        </TabsContent>

        <TabsContent value="template">
          <div className="grid gap-4 md:grid-cols-2">
            {templates.map((template) => (
              <SectionCard
                key={template.key}
                title={template.name}
                description={template.summary}
                footer={
                  <form action={formAction}>
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="mode" value="template" />
                    <input type="hidden" name="templateKey" value={template.key} />
                    <Button type="submit" variant="outline" disabled={pending}>
                      Use this template
                    </Button>
                  </form>
                }
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="blank">
          <SectionCard title="Start blank" description="A trigger and an end step to start from. Add steps on the canvas or configure each one in the step forms — no AI involved.">
            <form action={formAction} className="flex flex-col gap-3">
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="mode" value="blank" />
              <Field>
                <FieldLabel htmlFor="workflow-name-blank">Name</FieldLabel>
                <Input id="workflow-name-blank" name="name" maxLength={200} required />
              </Field>
              <div>
                <Button type="submit" disabled={pending}>
                  {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <PencilRuler data-icon="inline-start" aria-hidden="true" />}
                  Create and open the builder
                </Button>
              </div>
            </form>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  )
}

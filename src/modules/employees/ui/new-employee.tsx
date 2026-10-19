'use client'

// Creating an employee: describe it in plain language or pick a template,
// review the structured draft, then save it as version 1 (a draft that can't
// run until it is tested and activated).

import { CircleAlert, Info, LayoutTemplate, Sparkles, TriangleAlert } from 'lucide-react'
import { useActionState, useState } from 'react'

import { SectionCard } from '@/components/cards'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

import type { TemplateCard } from '../domain/templates'
import type { ConnectionOption, EmployeeToolInfo, KnowledgeSourceOption, SkillOption } from '../domain/types'
import { draftEmployeeAction, type DraftState } from '../server/actions'
import { EmployeeEditor } from './employee-editor'
import { TemplateGallery } from './template-gallery'

const IDLE: DraftState = { status: 'idle' }


const EXAMPLE =
  'Create a sales operations employee that researches leads, checks for CRM duplicates, prepares follow-up messages, and requests approval before sending.'

export function NewEmployee({
  organizationId,
  templates,
  tools,
  connections,
  sources,
  skills,
  modelConfigured,
}: {
  organizationId: string
  templates: TemplateCard[]
  tools: EmployeeToolInfo[]
  connections: ConnectionOption[]
  sources: KnowledgeSourceOption[]
  skills: SkillOption[]
  modelConfigured: boolean
}) {
  const [state, formAction, pending] = useActionState(draftEmployeeAction, IDLE)
  const [description, setDescription] = useState('')

  return (
    <div className="flex flex-col gap-6">
      <Tabs defaultValue="describe">
        <TabsList>
          <TabsTrigger value="describe">
            <Sparkles aria-hidden="true" />
            Describe it
          </TabsTrigger>
          <TabsTrigger value="template">
            <LayoutTemplate aria-hidden="true" />
            Start from a template
          </TabsTrigger>
        </TabsList>

        <TabsContent value="describe">
          <SectionCard
            title="Describe the employee"
            description={
              modelConfigured
                ? 'The AI model turns your description into a draft configuration for you to review. Nothing is saved until you save it.'
                : 'No AI model is configured on this deployment, so the draft is built with keyword rules. You’ll review and complete every field.'
            }
          >
            <form action={formAction} className="flex flex-col gap-3">
              <input type="hidden" name="organizationId" value={organizationId} />
              <Field>
                <FieldLabel htmlFor="employee-description-input">What should this employee do?</FieldLabel>
                <Textarea
                  id="employee-description-input"
                  name="description"
                  rows={4}
                  maxLength={2000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={EXAMPLE}
                />
                <FieldDescription>
                  Mention the work, the apps involved and when it should ask first.{' '}
                  <button type="button" className="underline underline-offset-4" onClick={() => setDescription(EXAMPLE)}>
                    Use the example
                  </button>
                </FieldDescription>
              </Field>
              <div>
                <Button type="submit" disabled={pending || description.trim().length < 10}>
                  {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Sparkles data-icon="inline-start" aria-hidden="true" />}
                  Draft the configuration
                </Button>
              </div>
            </form>
          </SectionCard>
        </TabsContent>

        <TabsContent value="template">
          <TemplateGallery templates={templates} pending={pending} action={formAction} organizationId={organizationId} />
        </TabsContent>
      </Tabs>

      <div aria-live="polite">
        {state.status === 'error' ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      {state.status === 'ready' ? (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Review the draft</h2>
          <Alert role="status">
            <Info aria-hidden="true" />
            <AlertTitle>{state.source === 'model' ? 'Drafted by the AI model' : state.source === 'template' ? 'Started from a template' : 'Drafted with keyword rules'}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {state.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
          {state.unsupported.length ? (
            <Alert>
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Not possible with the tools that exist today</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {state.unsupported.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          <EmployeeEditor
            key={state.nonce}
            organizationId={organizationId}
            initial={state.draft}
            tools={tools}
            connections={connections}
            sources={sources}
            skills={skills}
            submitLabel="Save as draft"
          />
        </div>
      ) : null}
    </div>
  )
}

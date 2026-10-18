'use client'

// Lets members ask a question and see exactly what an AI employee would get:
// cited passages, or a clear "not enough evidence" result.

import { CircleAlert, Search, TriangleAlert } from 'lucide-react'
import { useActionState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

import { searchKnowledgeAction, type KnowledgeSearchState } from '../server/actions'

const IDLE: KnowledgeSearchState = { status: 'idle' }

export function KnowledgeSearch({ organizationId, semanticAvailable }: { organizationId: string; semanticAvailable: boolean }) {
  const [state, action, pending] = useActionState(searchKnowledgeAction, IDLE)
  const queryErrors = state.status === 'error' ? state.fieldErrors?.query : undefined

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-3" aria-label="Search knowledge">
        <input type="hidden" name="organizationId" value={organizationId} />
        <Field data-invalid={queryErrors?.length ? true : undefined}>
          <FieldLabel htmlFor="knowledge-query">Question</FieldLabel>
          <div className="flex gap-2">
            <Input id="knowledge-query" name="query" maxLength={1000} placeholder="What is our refund policy?" aria-invalid={Boolean(queryErrors?.length)} />
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Search data-icon="inline-start" aria-hidden="true" />}
              Search
            </Button>
          </div>
          <FieldDescription>
            {semanticAvailable
              ? 'Searches by meaning and by keyword across ready documents and business context.'
              : 'Searches by keyword across ready documents and business context. Semantic search needs embeddings to be configured.'}
          </FieldDescription>
          {queryErrors?.length ? <FieldError errors={queryErrors.map((message) => ({ message }))} /> : null}
        </Field>
      </form>

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.status === 'error' && !queryErrors?.length ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}

        {state.status === 'done' ? (
          <>
            {state.result.verdict.sufficient ? (
              <p className="text-sm text-muted-foreground">
                {state.result.passages.length} relevant {state.result.passages.length === 1 ? 'passage' : 'passages'} found
                {state.result.semantic ? ' (keyword and semantic search)' : ' (keyword search)'}.
              </p>
            ) : (
              <Alert>
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>Not enough evidence</AlertTitle>
                <AlertDescription>
                  {state.insufficientMessage}
                  {state.result.passages.length ? ' The closest passages are shown below, but they don’t answer the question.' : ''}
                </AlertDescription>
              </Alert>
            )}
            <ol className="flex flex-col gap-3">
              {state.result.passages.map((passage) => (
                <li key={passage.chunkId} className="rounded-lg border p-4">
                  <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    <span className="rounded bg-muted px-1.5 font-mono text-xs">{passage.citation.label}</span>
                    <span className="font-medium break-words">{passage.citation.sourceName}</span>
                    {passage.citation.location ? <span className="text-muted-foreground">{passage.citation.location}</span> : null}
                  </div>
                  {passage.metadata.suspectedInstructions ? (
                    <p className="mb-2 flex items-start gap-1 text-xs text-warning">
                      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                      This passage reads like instructions to an AI. Employees treat it as information only and never follow it.
                    </p>
                  ) : null}
                  <p className="text-sm whitespace-pre-line">{passage.content}</p>
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>
    </div>
  )
}

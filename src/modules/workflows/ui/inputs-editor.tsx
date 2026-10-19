'use client'

// The workflow's inputs (what a person fills in to start a run, validated on
// the server against these declarations) and its run limits.

import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

import { INPUT_TYPE_LABELS, INPUT_TYPES, WORKFLOW_BOUNDS, type WorkflowDefinition, type WorkflowInput } from '../domain/types'
import { SELECT_CLASS } from './labels'

export function InputsEditor({ definition, readOnly = false, onChange }: { definition: WorkflowDefinition; readOnly?: boolean; onChange: (definition: WorkflowDefinition) => void }) {
  const setInputs = (inputs: WorkflowInput[]) => onChange({ ...definition, inputs })
  const update = (position: number, patch: Partial<WorkflowInput>) => setInputs(definition.inputs.map((input, index) => (index === position ? { ...input, ...patch } : input)))
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="inputs-heading">
        <div>
          <h3 id="inputs-heading" className="text-sm font-semibold">
            Run inputs
          </h3>
          <p className="text-sm text-muted-foreground">What a person fills in when starting a run. Steps use them as {'{{inputs.key}}'}. Each run’s values are checked against these on the server.</p>
        </div>
        {definition.inputs.map((input, position) => (
          <div key={position} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Field>
              <FieldLabel htmlFor={`input-${position}-key`}>Key</FieldLabel>
              <Input id={`input-${position}-key`} value={input.key} disabled={readOnly} onChange={(event) => update(position, { key: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`input-${position}-label`}>Label</FieldLabel>
              <Input id={`input-${position}-label`} value={input.label} disabled={readOnly} onChange={(event) => update(position, { label: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`input-${position}-type`}>Type</FieldLabel>
              <select id={`input-${position}-type`} className={SELECT_CLASS} value={input.type} disabled={readOnly} onChange={(event) => update(position, { type: event.target.value as WorkflowInput['type'] })}>
                {INPUT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {INPUT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end gap-2 pb-1">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={input.required} disabled={readOnly} onCheckedChange={(checked) => update(position, { required: checked === true })} />
                Required
              </label>
              {!readOnly ? (
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove input ${input.key}`} onClick={() => setInputs(definition.inputs.filter((_, index) => index !== position))}>
                  <Trash2 aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <Field className="sm:col-span-4">
              <FieldLabel htmlFor={`input-${position}-description`}>Help text</FieldLabel>
              <Input id={`input-${position}-description`} value={input.description} maxLength={300} disabled={readOnly} onChange={(event) => update(position, { description: event.target.value })} />
            </Field>
          </div>
        ))}
        {!readOnly && definition.inputs.length < WORKFLOW_BOUNDS.inputs ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setInputs([...definition.inputs, { key: `input_${definition.inputs.length + 1}`, label: 'New input', type: 'text', required: false, description: '' }])}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add an input
          </Button>
        ) : null}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="limits-heading">
        <h3 id="limits-heading" className="text-sm font-semibold">
          Limits
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="limit-minutes">Time limit per run (minutes)</FieldLabel>
            <Input
              id="limit-minutes"
              type="number"
              min={5}
              max={WORKFLOW_BOUNDS.maxRunMinutes}
              value={definition.settings.maxRunMinutes}
              disabled={readOnly}
              onChange={(event) => onChange({ ...definition, settings: { ...definition.settings, maxRunMinutes: Number(event.target.value) } })}
            />
            <FieldDescription>Waiting for approvals counts. A run that isn’t finished by then fails as timed out and its pending work is withdrawn.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="limit-cost">Model spending limit per run (USD)</FieldLabel>
            <Input
              id="limit-cost"
              type="number"
              min={0.01}
              step={0.01}
              max={WORKFLOW_BOUNDS.maxCostUsd}
              value={definition.settings.maxCostUsd ?? ''}
              placeholder="No limit"
              disabled={readOnly}
              onChange={(event) => onChange({ ...definition, settings: { ...definition.settings, maxCostUsd: event.target.value === '' ? null : Number(event.target.value) } })}
            />
            <FieldDescription>No new employee step starts once the run’s employees have spent this much. Each employee also keeps its own limits.</FieldDescription>
          </Field>
        </div>
      </section>
    </div>
  )
}

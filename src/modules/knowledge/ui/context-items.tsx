'use client'

// Lists and edits one kind of business context (FAQs, procedures, contacts…).
// Controls follow canManageContextKind() — a mirror of the database policies;
// the database decides when a change is saved.

import { Archive, ArchiveRestore, CircleAlert, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { FormDialog } from '@/components/forms/form-dialog'
import { SelectField, TextAreaField, TextField } from '@/components/forms/text-field'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FieldGroup } from '@/components/ui/field'

import { describeAttributes, type AttributeField, type ContextItem, type ContextKindDefinition } from '../domain/context-kinds'
import { deleteContextItem, saveContextItem, setContextItemArchived } from '../server/actions'

function AttributeInput({ field, value }: { field: AttributeField; value: string | number | undefined }) {
  const name = `attr_${field.key}`
  if (field.type === 'select') {
    return (
      <SelectField
        name={name}
        label={field.required ? field.label : `${field.label} (optional)`}
        defaultValue={value === undefined ? '' : String(value)}
        options={[...(field.required ? [] : [{ value: '', label: 'Not set' }]), ...field.options]}
      />
    )
  }
  if (field.type === 'integer') {
    return (
      <TextField
        name={name}
        label={field.required ? field.label : `${field.label} (optional)`}
        type="number"
        inputMode="numeric"
        min={field.min}
        max={field.max}
        description={field.description}
        defaultValue={value === undefined ? '' : String(value)}
      />
    )
  }
  return (
    <TextField
      name={name}
      label={field.required ? field.label : `${field.label} (optional)`}
      type={field.type === 'url' ? 'text' : field.type}
      inputMode={field.type === 'url' ? 'url' : undefined}
      maxLength={field.maxLength}
      placeholder={field.placeholder}
      description={field.description}
      defaultValue={value === undefined ? '' : String(value)}
    />
  )
}

function ItemFields({ definition, item }: { definition: ContextKindDefinition; item?: ContextItem }) {
  return (
    <FieldGroup>
      <TextField name="title" label={definition.titleLabel} required maxLength={definition.titleMaxLength} defaultValue={item?.title ?? ''} />
      {definition.attributes.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {definition.attributes.map((field) => (
            <AttributeInput key={field.key} field={field} value={item?.attributes[field.key]} />
          ))}
        </div>
      ) : null}
      <TextAreaField
        name="body"
        label={definition.bodyRequired ? definition.bodyLabel : `${definition.bodyLabel} (optional)`}
        description={definition.bodyDescription}
        rows={definition.kind === 'sop' || definition.kind === 'template' ? 8 : 4}
        maxLength={definition.bodyMaxLength}
        required={definition.bodyRequired}
        defaultValue={item?.body ?? ''}
      />
    </FieldGroup>
  )
}

export function ContextItemDialog({
  organizationId,
  definition,
  item,
}: {
  organizationId: string
  definition: ContextKindDefinition
  item?: ContextItem
}) {
  return (
    <FormDialog
      trigger={
        item ? (
          <Button variant="ghost" size="icon" aria-label={`Edit ${item.title}`}>
            <Pencil aria-hidden="true" />
          </Button>
        ) : (
          <Button>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add {definition.label.toLowerCase()}
          </Button>
        )
      }
      title={item ? `Edit ${definition.label.toLowerCase()}` : `Add ${definition.label.toLowerCase()}`}
      description={definition.description}
      action={saveContextItem}
      submitLabel="Save"
    >
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="kind" value={definition.kind} />
      {item ? <input type="hidden" name="id" value={item.id} /> : null}
      <ItemFields definition={definition} item={item} />
    </FormDialog>
  )
}

export function ContextItemList({
  organizationId,
  definition,
  items,
  indexStatus,
  canManage,
}: {
  organizationId: string
  definition: ContextKindDefinition
  items: readonly ContextItem[]
  /** Knowledge source status per item id, for indexed kinds. */
  indexStatus: Record<string, string>
  canManage: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const report = async (promise: Promise<{ status: string; message?: string }>) => {
    const result = await promise
    setError(result.status === 'error' ? (result.message ?? 'Something went wrong.') : null)
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="flex flex-col divide-y rounded-lg border">
        {items.map((item) => {
          const details = describeAttributes(definition.kind, item.attributes)
          const status = indexStatus[item.id]
          return (
            <li key={item.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium break-words">{item.title}</h3>
                  {item.status === 'archived' ? (
                    <StatusBadge kind="knowledgeSource" status="archived" />
                  ) : definition.indexed && status ? (
                    <StatusBadge kind="knowledgeSource" status={status} />
                  ) : null}
                </div>
                {details.length ? <p className="text-sm text-muted-foreground">{details.join(' · ')}</p> : null}
                {item.body ? <p className="line-clamp-3 text-sm whitespace-pre-line">{item.body}</p> : null}
              </div>
              {canManage ? (
                <div className="flex shrink-0 gap-1">
                  {item.status === 'active' ? <ContextItemDialog organizationId={organizationId} definition={definition} item={item} /> : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={item.status === 'active' ? `Archive ${item.title}` : `Restore ${item.title}`}
                    onClick={() => report(setContextItemArchived(organizationId, item.id, item.status === 'active'))}
                  >
                    {item.status === 'active' ? <Archive aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button variant="ghost" size="icon" aria-label={`Delete ${item.title}`}>
                        <Trash2 aria-hidden="true" />
                      </Button>
                    }
                    title={`Delete “${item.title}”?`}
                    description="AI employees will no longer use it. This can’t be undone; archive it instead if you may need it again."
                    confirmLabel="Delete"
                    destructive
                    onConfirm={() => deleteContextItem(organizationId, item.id)}
                  />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

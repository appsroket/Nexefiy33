'use client'

import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

import { ActionForm, FormMessage, SubmitButton, type FormAction } from './action-form'

/**
 * A dialog containing a Server Action form: focus is trapped while open,
 * Escape cancels, and the dialog closes itself when the action succeeds.
 */
export function FormDialog({
  trigger,
  title,
  description,
  action,
  submitLabel,
  pendingLabel,
  onSuccess,
  children,
}: {
  trigger: ReactNode
  title: string
  description?: ReactNode
  action: FormAction
  submitLabel: string
  pendingLabel?: string
  onSuccess?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Remount the form each time the dialog opens so old errors don't linger.
  const [formKey, setFormKey] = useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setFormKey((key) => key + 1)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        <ActionForm
          key={formKey}
          action={action}
          aria-label={title}
          className="flex flex-col gap-4"
          onSuccess={() => {
            setOpen(false)
            onSuccess?.()
          }}
        >
          <FormMessage />
          {children}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  )
}

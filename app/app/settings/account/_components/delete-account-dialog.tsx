"use client"

import { Loader2, Trash2 } from "lucide-react"
import { useState } from "react"

import { describe, Field, useFormAction } from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { deleteAccountAction } from "@/lib/gdpr/actions"
import { DELETE_CONFIRMATION } from "@/lib/gdpr/fields"

/**
 * "Delete account" (§14): a confirmation dialog where the person types DELETE. On success the
 * server signs this browser out and redirects; refusals (an active collab, unpaid earnings, …)
 * come back as a plain message.
 */
export function DeleteAccountDialog() {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const form = useFormAction(deleteAccountAction)
  const confirmationError = form.fieldError("confirmation")
  const formError = form.error && !confirmationError ? form.error.error : null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setTyped("")
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm" className="h-11 w-full sm:h-8 sm:w-fit">
          <Trash2 aria-hidden="true" />
          Delete account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete your account?</DialogTitle>
          <DialogDescription>
            This can&apos;t be undone. We remove your name, email, profiles, connected accounts,
            portfolio, messages and files, and sign you out everywhere. Sales, payouts and signed
            agreements stay on record without your contact details, as the law requires.
          </DialogDescription>
        </DialogHeader>
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <form action={form.formAction} noValidate className="space-y-4">
          <Field
            id="delete-confirmation"
            label={`Type ${DELETE_CONFIRMATION} to confirm`}
            error={confirmationError}
          >
            <Input
              id="delete-confirmation"
              name="confirmation"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              {...describe("delete-confirmation", { error: confirmationError })}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="destructive"
              className="h-11 sm:h-9"
              disabled={form.pending || typed.trim() !== DELETE_CONFIRMATION}
            >
              {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Delete my account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

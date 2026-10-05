"use client"

import { Loader2, LogOut } from "lucide-react"
import { useActionState, useState } from "react"

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
import type { ActionResult } from "@/lib/actions/result"
import { signOutEverywhereAction } from "@/lib/users/account-actions"

/** "Sign out everywhere" with a confirmation: ends every session, this one included. */
export function SignOutEverywhereButton() {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult<unknown> | null, formData: FormData) =>
      signOutEverywhereAction(formData),
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full sm:w-auto">
          <LogOut aria-hidden="true" />
          Sign out everywhere
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign out on every device?</DialogTitle>
          <DialogDescription>
            You&apos;ll be signed out here and on every other phone or computer. Sign in again with
            a link we email you.
          </DialogDescription>
        </DialogHeader>
        {state && !state.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        <form action={formAction}>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Sign out everywhere
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

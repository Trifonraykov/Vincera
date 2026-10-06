"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { disableTrackedLinkAction, renameTrackedLinkAction } from "@/lib/tracked-links/actions"
import { LINK_LABEL_MAX } from "@/lib/tracked-links/fields"

/** Rename and "Turn off" for the owner of a link (the default link can only be renamed). */
export function LinkOwnerActions({
  linkId,
  label,
  canDisable,
}: {
  linkId: string
  label: string
  canDisable: boolean
}) {
  const [renaming, setRenaming] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function rename(formData: FormData) {
    startTransition(async () => {
      const result = await renameTrackedLinkAction({
        linkId,
        label: String(formData.get("label") ?? ""),
      })
      if (result.ok) {
        setRenaming(false)
        setError(null)
        toast.success("Link renamed.")
      } else {
        setError(result.fieldErrors?.label?.[0] ?? result.error)
      }
    })
  }

  function disable() {
    startTransition(async () => {
      const result = await disableTrackedLinkAction({ linkId })
      if (result.ok) {
        setDisabling(false)
        toast.success("Link turned off.")
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <Button
          variant="outline"
          className="h-11 md:h-8"
          onClick={() => setRenaming(true)}
          aria-label={`Rename the link “${label}”`}
        >
          Rename
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename the link</DialogTitle>
            <DialogDescription>The link&apos;s address stays the same.</DialogDescription>
          </DialogHeader>
          <form action={rename} className="space-y-3" noValidate>
            <div className="space-y-2">
              <Label htmlFor={`rename-${linkId}`}>Name</Label>
              <Input
                id={`rename-${linkId}`}
                name="label"
                defaultValue={label}
                maxLength={LINK_LABEL_MAX}
                className="h-11 md:h-9"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `rename-${linkId}-error` : undefined}
              />
              {error ? (
                <p id={`rename-${linkId}-error`} className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" className="h-11 md:h-9">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending} className="h-11 md:h-9">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {canDisable ? (
        <Dialog open={disabling} onOpenChange={setDisabling}>
          <Button
            variant="outline"
            className="h-11 md:h-8"
            onClick={() => setDisabling(true)}
            aria-label={`Turn off the link “${label}”`}
          >
            Turn off
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Turn off this link?</DialogTitle>
              <DialogDescription>
                It keeps sending people to the product page, so old posts still work, but new clicks
                and sales are no longer counted for it, and its discount code stops working. This
                can&apos;t be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" className="h-11 md:h-9">
                  Keep it
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={disable}
                className="h-11 md:h-9"
              >
                Turn off
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}

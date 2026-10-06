"use client"

import { Archive, ArchiveRestore, Loader2 } from "lucide-react"
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
import { changeIdeaStatusAction } from "@/lib/ideas/actions"
import { changeProductStatusAction } from "@/lib/products/actions"
import type { SupplyKind } from "@/lib/supply/lifecycle"

/**
 * "Archive" (with a confirmation) and "Restore as draft" on `/app/ideas/[id]` and
 * `/app/products/[id]`. Publishing a draft is the form's own "Publish" button, so the latest
 * edits are saved with it. The page re-renders with the new status after the action.
 */

type StatusAction = "archive" | "restore"
type Result = ActionResult<{ status: string }> | null

function useStatusAction(kind: SupplyKind, id: string, onDone?: () => void) {
  return useActionState(async (_previous: Result, formData: FormData): Promise<Result> => {
    const action: StatusAction = formData.get("action") === "restore" ? "restore" : "archive"
    const result =
      kind === "idea"
        ? await changeIdeaStatusAction({ ideaId: id, action })
        : await changeProductStatusAction({ productId: id, action })
    if (result.ok) onDone?.()
    return result
  }, null)
}

function ActionError({ state }: { state: Result }) {
  if (!state || state.ok) return null
  return (
    <p role="alert" className="text-sm text-destructive">
      {state.error}
    </p>
  )
}

export function ArchiveButton({
  kind,
  id,
  title,
}: {
  kind: SupplyKind
  id: string
  title: string
}) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useStatusAction(kind, id, () => setOpen(false))
  const otherSide = kind === "idea" ? "Builders" : "Creators"
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full sm:w-auto">
          <Archive aria-hidden="true" />
          Archive {kind}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive “{title}”?</DialogTitle>
          <DialogDescription>
            {otherSide} won&apos;t see it any more and can&apos;t accept new proposals about it.
            Proposals already sent can&apos;t be accepted. You can restore it later as a draft.
          </DialogDescription>
        </DialogHeader>
        <ActionError state={state} />
        <form action={formAction}>
          <input type="hidden" name="action" value="archive" />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Keep it
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Archive
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RestoreButton({ kind, id }: { kind: SupplyKind; id: string }) {
  const [state, formAction, pending] = useStatusAction(kind, id)
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="action" value="restore" />
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <ArchiveRestore aria-hidden="true" />
        )}
        Restore as draft
      </Button>
      <ActionError state={state} />
    </form>
  )
}

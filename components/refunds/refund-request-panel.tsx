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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  approveRefundRequestAction,
  declineRefundRequestAction,
} from "@/lib/refund-requests/actions"
import { DECISION_NOTE_MAX } from "@/lib/refund-requests/fields"

/** Approve / Decline for one pending refund request (admins; dialogs confirm both). */
export function RefundDecisionButtons({
  requestId,
  amountLabel,
}: {
  requestId: string
  amountLabel: string
}) {
  const [open, setOpen] = useState<"approve" | "decline" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(kind: "approve" | "decline", formData: FormData) {
    const note = String(formData.get("note") ?? "")
    startTransition(async () => {
      const result =
        kind === "approve"
          ? await approveRefundRequestAction({ requestId, note })
          : await declineRefundRequestAction({ requestId, note })
      if (result.ok) {
        setOpen(null)
        setError(null)
        toast.success(kind === "approve" ? "Refund started." : "Request declined.")
      } else {
        setError(result.fieldErrors?.note?.[0] ?? result.error)
      }
    })
  }

  const dialog = (kind: "approve" | "decline") => {
    const noteId = `${kind}-note-${requestId}`
    return (
      <Dialog
        open={open === kind}
        onOpenChange={(next) => {
          setOpen(next ? kind : null)
          setError(null)
        }}
      >
        <Button
          variant={kind === "approve" ? "default" : "outline"}
          className="h-11 md:h-8"
          onClick={() => setOpen(kind)}
        >
          {kind === "approve" ? "Approve" : "Decline"}
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {kind === "approve" ? `Refund ${amountLabel}?` : "Decline this request?"}
            </DialogTitle>
            <DialogDescription>
              {kind === "approve"
                ? "The refund goes through Stripe now. The buyer gets a confirmation and the members' shares are taken back."
                : "The buyer gets your note by email. Their access keeps working."}
            </DialogDescription>
          </DialogHeader>
          <form action={(formData) => submit(kind, formData)} noValidate className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor={noteId}>
                {kind === "approve" ? "Note for the record" : "Note to the buyer"}
                {kind === "approve" ? (
                  <span className="font-normal text-muted-foreground">(optional)</span>
                ) : null}
              </Label>
              <Textarea
                id={noteId}
                name="note"
                rows={3}
                maxLength={DECISION_NOTE_MAX}
                className="text-base"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${noteId}-error` : undefined}
              />
              {error ? (
                <p id={`${noteId}-error`} className="text-sm text-destructive">
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
              <Button
                type="submit"
                disabled={pending}
                variant={kind === "approve" ? "default" : "destructive"}
                className="h-11 md:h-9"
              >
                {kind === "approve" ? "Refund" : "Decline"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {dialog("approve")}
      {dialog("decline")}
    </div>
  )
}

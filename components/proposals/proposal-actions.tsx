"use client"

import { Check, Loader2, Repeat2, Undo2, X } from "lucide-react"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { FormActions } from "@/components/profiles/form-kit"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ActionResult } from "@/lib/actions/result"
import {
  acceptProposalAction,
  declineProposalAction,
  withdrawProposalAction,
} from "@/lib/proposals/actions"
import { formatTimeline } from "@/lib/proposals/fields"
import type { ProposalAction } from "@/lib/proposals/state"
import { cn } from "@/lib/utils"

import { ProposalForm } from "./proposal-form"

type Terms = {
  creatorSplitPct: number
  builderSplitPct: number
  timelineWeeks: number
  scope: string
}

type Confirm = "accept" | "decline" | "withdraw" | null

/**
 * What the viewer can do with the offer on the table (CLAUDE.md §19.24 state machine): accept,
 * counter or decline when it waits for their answer; withdraw when it is their own offer.
 *
 * - Accept, decline and withdraw ask first (accept repeats the terms both sides will sign).
 * - Counter opens the terms form in a sheet: from the bottom on phones, from the side on wider
 *   screens, prefilled with the current terms.
 * - `layout="sticky"` is the phones' action bar (stuck above the tab bar while the page scrolls);
 *   `layout="inline"` the row under the terms on wider screens. The page renders both and hides
 *   one per breakpoint.
 */
export function ProposalActions({
  proposalId,
  revisionId,
  actions,
  terms,
  counterpartName,
  layout,
  className,
}: {
  proposalId: string
  revisionId: string
  actions: readonly ProposalAction[]
  terms: Terms
  counterpartName: string
  layout: "inline" | "sticky"
  className?: string
}) {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [countering, setCountering] = useState(false)
  const [pending, startTransition] = useTransition()
  const isMobile = useIsMobile()

  if (actions.length === 0) return null
  const canRespond = actions.includes("accept")

  function run(kind: Exclude<Confirm, null>) {
    startTransition(async () => {
      let result: ActionResult<unknown>
      if (kind === "accept") result = await acceptProposalAction({ proposalId, revisionId })
      else if (kind === "decline") result = await declineProposalAction({ proposalId, revisionId })
      else result = await withdrawProposalAction({ proposalId })
      setConfirm(null)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        kind === "accept"
          ? "Accepted. Your collab is set up: next, you both sign the agreement."
          : kind === "decline"
            ? "Proposal declined."
            : "Proposal withdrawn.",
      )
    })
  }

  const buttonSize = "h-11 sm:h-9"
  const buttons = (
    <>
      {canRespond ? (
        <>
          <Button onClick={() => setConfirm("accept")} className={buttonSize}>
            <Check aria-hidden="true" />
            Accept
          </Button>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button variant="outline" onClick={() => setCountering(true)} className={buttonSize}>
              <Repeat2 aria-hidden="true" />
              Counter
            </Button>
            <Button variant="outline" onClick={() => setConfirm("decline")} className={buttonSize}>
              <X aria-hidden="true" />
              Decline
            </Button>
          </div>
        </>
      ) : null}
      {actions.includes("withdraw") ? (
        <Button variant="outline" onClick={() => setConfirm("withdraw")} className={buttonSize}>
          <Undo2 aria-hidden="true" />
          Withdraw proposal
        </Button>
      ) : null}
    </>
  )

  return (
    <>
      {layout === "sticky" ? (
        <FormActions className={className}>{buttons}</FormActions>
      ) : (
        <div className={cn("flex flex-wrap gap-2", className)}>{buttons}</div>
      )}

      <Sheet open={countering} onOpenChange={setCountering}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn(
            "gap-0 overflow-y-auto overscroll-contain",
            isMobile ? "max-h-[92dvh] rounded-t-2xl pb-safe-2" : "w-full sm:max-w-lg",
          )}
        >
          <SheetHeader>
            <SheetTitle>Your counter-offer</SheetTitle>
            <SheetDescription>
              Change what you&apos;d like. {counterpartName} gets 14 days to answer it.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {countering ? (
              <ProposalForm
                mode="counter"
                hidden={{ proposalId, revisionId }}
                defaults={{
                  scope: terms.scope,
                  message: "",
                  creatorSplitPct: terms.creatorSplitPct,
                  timelineWeeks: terms.timelineWeeks,
                }}
                actionsClassName="bottom-0"
                onDone={() => setCountering(false)}
                onCancel={() => setCountering(false)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
        <DialogContent>
          {confirm === "accept" ? (
            <>
              <DialogHeader>
                <DialogTitle>Accept these terms?</DialogTitle>
                <DialogDescription>
                  This starts your collab with {counterpartName}. You&apos;ll both sign an agreement
                  with these terms next.
                </DialogDescription>
              </DialogHeader>
              <dl className="grid gap-2 rounded-lg border p-3 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Split</dt>
                  <dd className="text-right font-medium tabular-nums">
                    Creator {terms.creatorSplitPct}% · Builder {terms.builderSplitPct}%
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Timeline</dt>
                  <dd className="font-medium">{formatTimeline(terms.timelineWeeks)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Scope</dt>
                  <dd className="mt-1 line-clamp-6 break-words whitespace-pre-wrap">
                    {terms.scope}
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <DialogHeader>
              <DialogTitle>
                {confirm === "decline" ? "Decline this proposal?" : "Withdraw your proposal?"}
              </DialogTitle>
              <DialogDescription>
                {confirm === "decline"
                  ? `${counterpartName} will be told you declined. This can't be undone, but either of you can send a new proposal later.`
                  : `${counterpartName} won't be able to answer it any more. You can send a new one later.`}
              </DialogDescription>
            </DialogHeader>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending} className={buttonSize}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={confirm === "accept" ? "default" : "destructive"}
              disabled={pending}
              onClick={() => confirm && run(confirm)}
              className={buttonSize}
            >
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {confirm === "accept"
                ? "Accept and start the collab"
                : confirm === "decline"
                  ? "Decline"
                  : "Withdraw"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

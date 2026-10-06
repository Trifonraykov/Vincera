"use client"

import { Bookmark, BookmarkCheck, Loader2, X } from "lucide-react"
import { useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/actions/result"
import { dismissMatchAction, saveMatchAction, unsaveMatchAction } from "@/lib/matching/actions"
import { cn } from "@/lib/utils"

import { useMatchCard } from "./match-card-frame"

/**
 * Save / Unsave and Dismiss for one match. Both are 44 px tall on touch screens. Dismissing hides
 * the card at once (the list re-renders without it); saving toggles in place.
 */
export function MatchCardActions({
  matchId,
  rank,
  saved,
  title,
  className,
}: {
  matchId: string
  rank: number | null
  saved: boolean
  title: string
  className?: string
}) {
  const [pending, startTransition] = useTransition()
  const card = useMatchCard()

  function run(kind: "save" | "unsave" | "dismiss") {
    startTransition(async () => {
      const input = { matchId, rank }
      let result: ActionResult<unknown>
      if (kind === "save") result = await saveMatchAction(input)
      else if (kind === "unsave") result = await unsaveMatchAction(input)
      else result = await dismissMatchAction(input)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (kind === "dismiss") {
        card?.dismiss()
        toast.success("Dismissed. We won't suggest it again.")
      } else {
        toast.success(kind === "save" ? "Saved." : "Removed from saved.")
      }
    })
  }

  const SaveIcon = saved ? BookmarkCheck : Bookmark
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        type="button"
        variant="outline"
        className="h-11 sm:h-9"
        aria-pressed={saved}
        aria-label={saved ? `Saved: ${title}. Remove from saved` : `Save ${title}`}
        disabled={pending}
        onClick={() => run(saved ? "unsave" : "save")}
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <SaveIcon aria-hidden="true" />
        )}
        {saved ? "Saved" : "Save"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="h-11 text-muted-foreground sm:h-9"
        aria-label={`Dismiss ${title}`}
        disabled={pending}
        onClick={() => run("dismiss")}
      >
        <X aria-hidden="true" />
        Dismiss
      </Button>
    </div>
  )
}

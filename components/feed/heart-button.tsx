"use client"

import { Heart } from "lucide-react"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { saveFeedListingAction, unsaveFeedListingAction } from "@/lib/feed/actions"
import { cn } from "@/lib/utils"

/**
 * The feed's heart (CLAUDE.md §19.45): saves the listing for later (Discover → Saved lists it).
 * Optimistic, 44 px, with a small pop; a refusal puts it back and says why.
 */
export function HeartButton({
  productId,
  title,
  saved: initial,
  rank,
  surface = "feed",
  variant = "overlay",
  className,
}: {
  productId: string
  title: string
  saved: boolean
  rank: number | null
  surface?: "feed" | "profile"
  variant?: "overlay" | "plain"
  className?: string
}) {
  const [saved, setSaved] = useState(initial)
  const [pending, startTransition] = useTransition()

  function toggle() {
    const next = !saved
    setSaved(next)
    if (next && typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(8)
    startTransition(async () => {
      const input = { productId, rank, surface }
      const result = next
        ? await saveFeedListingAction(input)
        : await unsaveFeedListingAction(input)
      if (!result.ok) {
        setSaved(!next)
        toast.error(result.error)
      }
    })
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        toggle()
      }}
      aria-pressed={saved}
      aria-label={saved ? `Saved: ${title}. Remove from saved` : `Save ${title}`}
      data-pending={pending || undefined}
      className={cn(
        "group/heart inline-flex size-11 items-center justify-center rounded-full transition-transform active:scale-90",
        variant === "overlay"
          ? "bg-black/30 text-white backdrop-blur-md hover:bg-black/40"
          : "border bg-background text-foreground hover:bg-accent",
        className,
      )}
    >
      <Heart
        aria-hidden="true"
        className={cn(
          "size-5 transition-all duration-200",
          saved &&
            "scale-110 fill-rose-500 text-rose-500 motion-safe:animate-[heart-pop_300ms_ease-out]",
        )}
      />
    </button>
  )
}

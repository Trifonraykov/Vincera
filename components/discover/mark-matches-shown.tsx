"use client"

import { useEffect } from "react"

import { markMatchesShownAction } from "@/lib/matching/actions"

/**
 * Records `match.shown` for the cards on screen, once per page view (batched; the server records
 * each match only the first time). From the browser after rendering, never during render, so a
 * prefetch counts nothing. Renders nothing.
 */
export function MarkMatchesShown({
  items,
}: {
  items: readonly { matchId: string; rank: number }[]
}) {
  const key = items.map((item) => `${item.matchId}:${item.rank}`).join(",")
  useEffect(() => {
    if (!key) return
    const batch = key.split(",").map((entry) => {
      const [matchId = "", rank = "0"] = entry.split(":")
      return { matchId, rank: Number(rank) }
    })
    void markMatchesShownAction({ items: batch })
  }, [key])
  return null
}

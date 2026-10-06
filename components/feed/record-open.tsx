"use client"

import { useEffect } from "react"

import { openFeedListingAction } from "@/lib/feed/actions"

/** Records that the listing was opened (`match.clicked` or `listing.opened`), once, after render. */
export function RecordListingOpen({ productId, rank }: { productId: string; rank: number | null }) {
  useEffect(() => {
    void openFeedListingAction({ productId, rank })
  }, [productId, rank])
  return null
}

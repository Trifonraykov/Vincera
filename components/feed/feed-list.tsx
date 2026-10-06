"use client"

import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { loadFeedPageAction, markFeedShownAction } from "@/lib/feed/actions"
import type { FeedItem } from "@/lib/feed/queries"

import { FeedCard } from "./feed-card"

/**
 * The scrolling feed (CLAUDE.md §19.45): one column of big cards, the next page loaded as the
 * end comes near (and a button for keyboards and when observers are unavailable). Each page
 * records `feed.viewed` (and `match.shown` for matched listings) from the browser, after it is on
 * screen, never during render, so a prefetch counts nothing.
 */
export function FeedList({
  initialItems,
  initialCursor,
}: {
  initialItems: FeedItem[]
  initialCursor: string | null
}) {
  const [items, setItems] = useState(initialItems)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const pages = useRef(0)

  const markShown = useCallback((page: FeedItem[], offset: number) => {
    pages.current += 1
    void markFeedShownAction({
      page: pages.current,
      items: page.map((item, index) => ({
        productId: item.id,
        matchId: item.matchId,
        rank: offset + index + 1,
      })),
    })
  }, [])

  useEffect(() => {
    if (initialItems.length > 0) markShown(initialItems, 0)
  }, [initialItems, markShown])

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return
    setLoading(true)
    setFailed(false)
    const result = await loadFeedPageAction({ cursor })
    setLoading(false)
    if (!result.ok) {
      setFailed(true)
      return
    }
    const offset = items.length
    setItems((current) => {
      const seen = new Set(current.map((item) => item.id))
      return [...current, ...result.data.items.filter((item) => !seen.has(item.id))]
    })
    setCursor(result.data.nextCursor)
    if (result.data.items.length > 0) markShown(result.data.items, offset)
  }, [cursor, loading, items.length, markShown])

  useEffect(() => {
    const node = sentinel.current
    if (!node || !cursor || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { rootMargin: "800px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, loadMore])

  return (
    <div className="space-y-5">
      <ol className="space-y-5" aria-label="Products for you">
        {items.map((item, index) => (
          <li key={item.id}>
            <FeedCard listing={item} saved={item.saved} rank={index + 1} eager={index < 2} />
          </li>
        ))}
      </ol>
      <div ref={sentinel} className="flex justify-center py-4">
        {cursor ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 text-muted-foreground"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {failed ? "Try again" : loading ? "Loading" : "Show more"}
          </Button>
        ) : items.length > 0 ? (
          <p className="text-sm text-muted-foreground">You&apos;re all caught up.</p>
        ) : null}
      </div>
    </div>
  )
}

"use client"

import { useEffect } from "react"

import { markThreadReadAction } from "@/lib/messages/actions"

/**
 * Marks the thread read up to the newest message on screen once the messages are shown (CLAUDE.md
 * §19.24 "Opening a thread", §19.30): not the thread's newest at the time the action runs, so a
 * message posted after the render stays unread. From the browser, not while rendering, so a
 * prefetch of the page never marks anything read. Runs again when a newer message arrives.
 * Renders nothing.
 */
export function MarkThreadRead({
  threadId,
  newestMessageId,
}: {
  threadId: string
  newestMessageId: string | null
}) {
  useEffect(() => {
    if (!newestMessageId) return
    void markThreadReadAction({ threadId, messageId: newestMessageId })
  }, [threadId, newestMessageId])
  return null
}

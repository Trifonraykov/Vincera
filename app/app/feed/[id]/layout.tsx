import { notFound } from "next/navigation"
import type { ReactNode } from "react"
import { z } from "zod"

import { canBrowseFeed } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { findFeedListing } from "@/lib/feed/queries"

/**
 * A feed listing is visible to creators while it is open (CLAUDE.md §19.45). Checked here, outside
 * any Suspense boundary, so a hidden listing answers a real 404 (§19.29); the page checks again.
 */
export default async function FeedListingLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!canBrowseFeed(user) || !z.uuid().safeParse(id).success) notFound()
  if (!(await findFeedListing(getDb(), { viewerId: user.id, productId: id }))) notFound()
  return children
}

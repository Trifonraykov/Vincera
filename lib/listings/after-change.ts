import "server-only"

import { revalidatePath } from "next/cache"

import type { DbOrTx } from "@/lib/db/client"
import { requestEmbeddingRefreshAfterCommit } from "@/lib/embeddings/request"
import { revalidatePublicProfiles } from "@/lib/social/revalidate"

import { APP_STORE_MESSAGES } from "./app-store/service"
import type { ListingWriteResult } from "./store"

/**
 * After an import committed (web action, mobile API, CLAUDE.md §19.45): each listing that changed
 * asks for its embedding (which asks matching to rescore it), and the pages showing listings are
 * revalidated.
 */
export async function afterListingsChange(
  db: DbOrTx,
  userId: string,
  listings: readonly ListingWriteResult[],
): Promise<void> {
  for (const listing of listings) {
    if (listing.action === "unchanged") continue
    await requestEmbeddingRefreshAfterCommit({ type: "product", id: listing.productId })
  }
  revalidatePath("/app/products")
  revalidatePath("/app/feed")
  revalidatePath("/onboarding/builder/portfolio")
  await revalidatePublicProfiles(db, userId)
}

export function refreshErrorMessage(error: "not_connected" | "not_found" | "unavailable"): string {
  return error === "not_connected"
    ? APP_STORE_MESSAGES.noAccount
    : error === "not_found"
      ? APP_STORE_MESSAGES.notFound
      : APP_STORE_MESSAGES.unavailable
}

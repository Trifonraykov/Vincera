import type { DbOrTx } from "@/lib/db/client"
import { loadImportPanel } from "@/lib/listings/queries"

import { ImportPanel } from "./import-panel"

/** Loads the builder's import state and renders the panel (nothing without a builder profile). */
export async function ImportListingsSection({
  db,
  userId,
  compact,
}: {
  db: DbOrTx
  userId: string
  compact?: boolean
}) {
  const data = await loadImportPanel(db, userId)
  if (!data) return null
  return (
    <ImportPanel
      compact={compact}
      appStore={
        data.appStore
          ? {
              developerName: data.appStore.developerName,
              developerUrl: data.appStore.developerUrl,
              verified: data.appStore.verified,
              verificationCode: data.appStore.verificationCode,
              syncedAt: data.appStore.syncedAt?.toISOString() ?? null,
              syncError: data.appStore.syncError,
            }
          : null
      }
      listings={data.listings.map((listing) => ({
        id: listing.id,
        title: listing.title,
        source: listing.source,
        removed: listing.removed,
        iconUrl: listing.iconUrl,
        coverUrl: listing.coverUrl,
        gradient: listing.visual.gradient,
        initials: listing.visual.initials,
      }))}
    />
  )
}

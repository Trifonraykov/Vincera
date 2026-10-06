import "server-only"

import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, products, type ProductStatus } from "@/lib/db/schema"
import { PUBLIC_PRODUCT_STATUSES } from "@/lib/auth/authz"

import { appStoreVerificationCode } from "./app-store/service"
import { developerPageUrl } from "./app-store/link"
import { toListingCard, type ListingCard } from "./cards"

/** What the import panels show a builder (CLAUDE.md §19.45). */

export type AppStoreAccountView = {
  developerId: string
  developerName: string | null
  country: string
  developerUrl: string
  verified: boolean
  verificationMethod: "description_code" | "admin" | null
  /** The code to put in an app description (only while unverified). */
  verificationCode: string | null
  syncedAt: Date | null
  syncError: string | null
}

export type ImportedListingRow = {
  id: string
  title: string
  source: "app_store" | "web"
  status: ProductStatus
  removed: boolean
  sourceLabel: string | null
  iconUrl: string | null
  coverUrl: string | null
  visual: ListingCard["visual"]
  updatedAt: Date
}

export type ImportPanelData = {
  builderProfileId: string
  appStore: AppStoreAccountView | null
  listings: ImportedListingRow[]
}

export async function loadImportPanel(
  database: DbOrTx,
  userId: string,
): Promise<ImportPanelData | null> {
  const [profile] = await database
    .select({
      id: builderProfiles.id,
      handle: builderProfiles.handle,
      displayName: builderProfiles.displayName,
      developerId: builderProfiles.appStoreDeveloperId,
      developerName: builderProfiles.appStoreDeveloperName,
      country: builderProfiles.appStoreCountry,
      verifiedAt: builderProfiles.appStoreVerifiedAt,
      method: builderProfiles.appStoreVerificationMethod,
      syncedAt: builderProfiles.appStoreSyncedAt,
      syncError: builderProfiles.appStoreSyncError,
    })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))
    .limit(1)
  if (!profile) return null
  const rows = await database
    .select({
      id: products.id,
      title: products.title,
      description: products.description,
      tagline: products.tagline,
      format: products.format,
      source: products.source,
      sourceMeta: products.sourceMeta,
      media: products.media,
      status: products.status,
      sourceRemovedAt: products.sourceRemovedAt,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(and(eq(products.builderProfileId, profile.id), ne(products.source, "manual")))
    .orderBy(desc(products.createdAt), desc(products.id))
    .limit(60)
  return {
    builderProfileId: profile.id,
    appStore:
      profile.developerId && profile.country
        ? {
            developerId: profile.developerId,
            developerName: profile.developerName,
            country: profile.country,
            developerUrl: developerPageUrl(profile.developerId, profile.country),
            verified: profile.verifiedAt !== null,
            verificationMethod: profile.method,
            verificationCode: profile.verifiedAt
              ? null
              : appStoreVerificationCode(profile.id, profile.developerId),
            syncedAt: profile.syncedAt,
            syncError: profile.syncError,
          }
        : null,
    listings: rows.map((row) => {
      const card = toListingCard({
        ...row,
        builderUserId: userId,
        builderHandle: profile.handle,
        builderDisplayName: profile.displayName,
        builderAppStoreVerified: profile.verifiedAt !== null,
      })
      return {
        id: row.id,
        title: row.title,
        source: row.source === "app_store" ? "app_store" : "web",
        status: row.status,
        removed: row.sourceRemovedAt !== null,
        sourceLabel: card.sourceLabel,
        iconUrl: card.icon?.url ?? null,
        coverUrl: card.cover?.url ?? null,
        visual: card.visual,
        updatedAt: row.updatedAt,
      }
    }),
  }
}

/**
 * A builder's public listings for their profile grid (`/b/[handle]`, the app): published, still
 * in their store, newest first.
 */
export async function listBuilderListings(
  database: DbOrTx,
  input: { builderProfileId: string; limit?: number },
): Promise<ListingCard[]> {
  const rows = await database
    .select({
      id: products.id,
      title: products.title,
      description: products.description,
      tagline: products.tagline,
      format: products.format,
      source: products.source,
      sourceMeta: products.sourceMeta,
      media: products.media,
      builderUserId: builderProfiles.userId,
      builderHandle: builderProfiles.handle,
      builderDisplayName: builderProfiles.displayName,
      verifiedAt: builderProfiles.appStoreVerifiedAt,
    })
    .from(products)
    .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(
      and(
        eq(products.builderProfileId, input.builderProfileId),
        inArray(products.status, [...PUBLIC_PRODUCT_STATUSES]),
        isNull(products.sourceRemovedAt),
      ),
    )
    .orderBy(desc(products.publishedAt), desc(products.id))
    .limit(input.limit ?? 60)
  return rows.map(({ verifiedAt, ...row }) =>
    toListingCard({ ...row, builderAppStoreVerified: verifiedAt !== null }),
  )
}

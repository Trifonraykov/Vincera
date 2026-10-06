"use server"

import { revalidatePath } from "next/cache"
import { eq } from "drizzle-orm"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { writeAdminAudit } from "@/lib/admin/audit"
import { canImportListings, canVerifyAppStoreAccount } from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles } from "@/lib/db/schema"
import { requestEmbeddingRefreshAfterCommit } from "@/lib/embeddings/request"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"
import { revalidatePublicProfiles } from "@/lib/social/revalidate"

import {
  APP_STORE_MESSAGES,
  checkAppStoreVerification,
  connectAppStore,
  disconnectAppStore,
  markAppStoreVerified,
  syncAppStore,
  type AppStoreSyncSummary,
} from "./app-store/service"
import type { ListingWriteResult } from "./store"
import { importWebListing } from "./web/service"

/**
 * Builder-side listing imports (CLAUDE.md §19.45): connect / refresh / verify / disconnect an App
 * Store developer account, and import a product from a web link. Authorized with
 * `canImportListings` (active builders); each is rate limited per user. After the commit every
 * listing that changed asks for its embedding (which asks matching to rescore it), and the pages
 * that show listings are revalidated.
 */

const LISTING_RATE_LIMITS = {
  appStoreConnect: { limit: 10, window: "1 h" },
  appStoreRefresh: { limit: 6, window: "1 h" },
  appStoreVerify: { limit: 20, window: "1 h" },
  webImport: { limit: 15, window: "1 h" },
} as const satisfies Record<string, RateLimitRule>

const LIMITED = "You've done that a lot just now. Try again in a little while."

async function limit(bucket: string, userId: string, rule: RateLimitRule): Promise<void> {
  const result = await rateLimit(bucket, userId, rule)
  if (!result.success) throw new ActionError(LIMITED)
}

async function afterListingsChange(
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

function summaryWire(summary: AppStoreSyncSummary) {
  return {
    developerName: summary.developerName,
    apps: summary.apps,
    created: summary.created,
    updated: summary.updated,
    removed: summary.removed,
  }
}

export const connectAppStoreAction = defineAction({
  name: "listings.app_store.connect",
  input: z.object({
    appStore: z
      .string({ error: "Paste your App Store link or developer id." })
      .trim()
      .min(1, "Paste your App Store link or developer id.")
      .max(500, "That link is too long."),
  }),
  authorize: (user) => canImportListings(user),
  run: async ({ input, user, db }) => {
    await limit("app-store-connect", user.id, LISTING_RATE_LIMITS.appStoreConnect)
    const summary = await connectAppStore(db, { userId: user.id, raw: input.appStore })
    await afterListingsChange(db, user.id, summary.listings)
    return summaryWire(summary)
  },
})

async function ownProfileId(db: DbOrTx, userId: string): Promise<string> {
  const [profile] = await db
    .select({ id: builderProfiles.id })
    .from(builderProfiles)
    .where(eq(builderProfiles.userId, userId))
    .limit(1)
  if (!profile) throw new ActionError(APP_STORE_MESSAGES.noProfile)
  return profile.id
}

export const refreshAppStoreAction = defineAction({
  name: "listings.app_store.refresh",
  input: z.object({}),
  authorize: (user) => canImportListings(user),
  run: async ({ user, db }) => {
    await limit("app-store-refresh", user.id, LISTING_RATE_LIMITS.appStoreRefresh)
    const result = await syncAppStore(db, {
      builderProfileId: await ownProfileId(db, user.id),
      actorUserId: user.id,
      trigger: "manual",
    })
    if ("error" in result) {
      throw new ActionError(
        result.error === "not_connected"
          ? APP_STORE_MESSAGES.noAccount
          : result.error === "not_found"
            ? APP_STORE_MESSAGES.notFound
            : APP_STORE_MESSAGES.unavailable,
      )
    }
    await afterListingsChange(db, user.id, result.listings)
    return summaryWire(result)
  },
})

export const checkAppStoreVerificationAction = defineAction({
  name: "listings.app_store.verify",
  input: z.object({}),
  authorize: (user) => canImportListings(user),
  run: async ({ user, db }) => {
    await limit("app-store-verify", user.id, LISTING_RATE_LIMITS.appStoreVerify)
    const result = await checkAppStoreVerification(db, { userId: user.id })
    if (!result.verified) throw new ActionError(APP_STORE_MESSAGES.codeMissing)
    revalidatePath("/app/products")
    revalidatePath("/app/feed")
    await revalidatePublicProfiles(db, user.id)
    return result
  },
})

export const disconnectAppStoreAction = defineAction({
  name: "listings.app_store.disconnect",
  input: z.object({}),
  authorize: (user) => canImportListings(user),
  run: async ({ user, db }) => {
    await disconnectAppStore(db, { userId: user.id })
    revalidatePath("/app/products")
    await revalidatePublicProfiles(db, user.id)
    return { ok: true }
  },
})

export const importWebListingAction = defineAction({
  name: "listings.web.import",
  input: z.object({
    url: z
      .string({ error: "Paste the link to your product's page." })
      .trim()
      .min(1, "Paste the link to your product's page.")
      .max(2000, "That link is too long."),
  }),
  authorize: (user) => canImportListings(user),
  run: async ({ input, user, db }) => {
    await limit("web-listing-import", user.id, LISTING_RATE_LIMITS.webImport)
    const result = await importWebListing(db, { userId: user.id, url: input.url })
    await afterListingsChange(db, user.id, [result])
    return { productId: result.productId, title: result.title, action: result.action }
  },
})

/** Admins: mark a builder's App Store account as checked by hand (audited). */
export const adminVerifyAppStoreAction = defineAction({
  name: "admin.app_store.verify",
  input: z.object({ builderProfileId: z.uuid() }),
  authorize: (user) => canVerifyAppStoreAccount(user),
  run: async ({ input, user, db }) => {
    const [profile] = await db
      .select({
        userId: builderProfiles.userId,
        developerId: builderProfiles.appStoreDeveloperId,
      })
      .from(builderProfiles)
      .where(eq(builderProfiles.id, input.builderProfileId))
      .limit(1)
    if (!profile?.developerId) throw new ActionError(APP_STORE_MESSAGES.noAccount)
    const developerId = profile.developerId
    await markAppStoreVerified(
      db,
      {
        builderProfileId: input.builderProfileId,
        developerId,
        method: "admin",
        actorUserId: user.id,
      },
      (tx) =>
        writeAdminAudit(tx, {
          adminUserId: user.id,
          action: "app_store.verified",
          targetType: "builder_profile",
          targetId: input.builderProfileId,
          before: { app_store_verified: false },
          after: { app_store_verified: true, developer_id: developerId },
        }).then(() => undefined),
    )
    revalidatePath(`/admin/users/${profile.userId}`)
    await revalidatePublicProfiles(db, profile.userId)
    return { ok: true }
  },
})

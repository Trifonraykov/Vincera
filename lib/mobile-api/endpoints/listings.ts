import "server-only"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { canBrowseFeed, canImportListings } from "@/lib/auth/authz"
import type { AuthUser } from "@/lib/auth/user"
import {
  FEED_MESSAGES,
  recordFeedOpen,
  recordFeedShown,
  saveFeedListing,
  unsaveFeedListing,
} from "@/lib/feed/interactions"
import { findFeedListing, listFeed } from "@/lib/feed/queries"
import { afterListingsChange, refreshErrorMessage } from "@/lib/listings/after-change"
import {
  checkAppStoreVerification,
  connectAppStore,
  disconnectAppStore,
  syncAppStore,
  APP_STORE_MESSAGES,
} from "@/lib/listings/app-store/service"
import type { ListingCard } from "@/lib/listings/cards"
import { limitListingImport } from "@/lib/listings/limits"
import { loadImportPanel } from "@/lib/listings/queries"
import { importWebListing } from "@/lib/listings/web/service"
import { isValidHandle, loadPublicBuilderProfile } from "@/lib/public-profiles/load"
import { ActionError } from "@/lib/actions/errors"
import { findBuilderProfileId } from "@/lib/products/queries"

import { webUrl } from "../context"
import { forbidden, MobileApiError } from "../errors"
import { endpoint, uuidParam, type Endpoint } from "../router"
import {
  appStoreConnectInput,
  appStoreSyncOutput,
  appStoreVerifyOutput,
  builderProfileGridOutput,
  feedActionInput,
  feedDetailOutput,
  feedOutput,
  feedQuery,
  feedSaveOutput,
  feedShownInput,
  importStatusOutput,
  markShownOutput,
  okSchema,
  webImportInput,
  webImportOutput,
} from "../schemas"

/**
 * The creator feed and the builder's listing imports for the iPhone app (CLAUDE.md §19.44,
 * §19.45). Same authz rules, services, events and rate limits as the web; image paths become
 * absolute URLs of the server's media route.
 */

function requireFeed(user: AuthUser): void {
  if (!canBrowseFeed(user)) throw forbidden()
}

function requireImports(user: AuthUser): void {
  if (!canImportListings(user)) throw forbidden()
}

function absoluteImage<T extends { url: string } | null>(image: T): T {
  return (image ? { ...image, url: webUrl(image.url) } : image) as T
}

/** A card with absolute image URLs. */
export function cardWire<T extends ListingCard>(card: T): T {
  return {
    ...card,
    icon: absoluteImage(card.icon),
    cover: absoluteImage(card.cover),
    screenshots: card.screenshots.map((shot) => absoluteImage(shot)),
  }
}

function summaryWire(summary: {
  developerName: string
  apps: number
  created: number
  updated: number
  removed: number
}) {
  return {
    developerName: summary.developerName,
    apps: summary.apps,
    created: summary.created,
    updated: summary.updated,
    removed: summary.removed,
  }
}

export const listingEndpoints: Endpoint[] = [
  endpoint({
    method: "GET",
    path: "/feed",
    auth: "onboarded",
    query: feedQuery,
    output: feedOutput,
    run: async ({ db, user, query }) => {
      requireFeed(user)
      const page = await listFeed(db, { viewerId: user.id, cursor: query.cursor ?? null })
      return { items: page.items.map(cardWire), nextCursor: page.nextCursor }
    },
  }),
  endpoint({
    method: "GET",
    path: "/feed/:id",
    auth: "onboarded",
    output: feedDetailOutput,
    run: async ({ db, user, params }) => {
      requireFeed(user)
      const listing = await findFeedListing(db, { viewerId: user.id, productId: uuidParam(params) })
      if (!listing) throw new MobileApiError(404, "not_found", FEED_MESSAGES.notFound)
      return cardWire(listing)
    },
  }),
  endpoint({
    method: "POST",
    path: "/feed/:id/save",
    auth: "onboarded",
    input: feedActionInput,
    output: feedSaveOutput,
    run: async ({ db, user, params, input }) => {
      requireFeed(user)
      const productId = uuidParam(params)
      await saveFeedListing(db, { userId: user.id, productId, rank: input.rank ?? null })
      revalidatePath("/app/discover/saved")
      return { saved: true }
    },
  }),
  endpoint({
    method: "POST",
    path: "/feed/:id/unsave",
    auth: "onboarded",
    input: feedActionInput,
    output: feedSaveOutput,
    run: async ({ db, user, params, input }) => {
      requireFeed(user)
      const productId = uuidParam(params)
      await unsaveFeedListing(db, { userId: user.id, productId, rank: input.rank ?? null })
      revalidatePath("/app/discover/saved")
      return { saved: false }
    },
  }),
  endpoint({
    method: "POST",
    path: "/feed/:id/open",
    auth: "onboarded",
    input: feedActionInput,
    output: okSchema,
    run: async ({ db, user, params, input }) => {
      requireFeed(user)
      try {
        await recordFeedOpen(db, {
          userId: user.id,
          productId: uuidParam(params),
          rank: input.rank ?? null,
        })
      } catch (error) {
        if (error instanceof ActionError) {
          throw new MobileApiError(404, "not_found", FEED_MESSAGES.notFound)
        }
        throw error
      }
      return { ok: true }
    },
  }),
  endpoint({
    method: "POST",
    path: "/feed/shown",
    auth: "onboarded",
    input: feedShownInput,
    output: markShownOutput,
    run: async ({ db, user, input }) => {
      requireFeed(user)
      const ids = z.array(z.uuid()).safeParse(input.items.map((item) => item.productId))
      if (!ids.success) throw new MobileApiError(400, "invalid_input", "Unknown listing.")
      // Only the viewer's own match rows are touched (markMatchesShown scopes by user).
      const result = await recordFeedShown(db, { userId: user.id, ...input })
      return { recorded: result.marked }
    },
  }),
  endpoint({
    method: "GET",
    path: "/builders/:handle",
    auth: "user",
    output: builderProfileGridOutput,
    run: async ({ db, params }) => {
      const handle = (params.handle ?? "").toLowerCase()
      if (!isValidHandle(handle)) throw new MobileApiError(404, "not_found", "Not found.")
      const profile = await loadPublicBuilderProfile(db, handle)
      if (!profile) throw new MobileApiError(404, "not_found", "Not found.")
      return {
        handle: profile.handle,
        displayName: profile.displayName,
        bio: profile.bio,
        skills: profile.skills,
        appStore: profile.appStore,
        listings: profile.listings.map(cardWire),
      }
    },
  }),
  endpoint({
    method: "GET",
    path: "/listings/import",
    auth: "onboarded",
    output: importStatusOutput,
    run: async ({ db, user }) => {
      requireImports(user)
      const data = await loadImportPanel(db, user.id)
      if (!data) throw new MobileApiError(422, "refused", APP_STORE_MESSAGES.noProfile)
      return {
        appStore: data.appStore
          ? {
              developerName: data.appStore.developerName,
              developerUrl: data.appStore.developerUrl,
              verified: data.appStore.verified,
              verificationCode: data.appStore.verificationCode,
              syncedAt: data.appStore.syncedAt?.toISOString() ?? null,
              syncError: data.appStore.syncError,
            }
          : null,
        listings: data.listings.map((listing) => ({
          id: listing.id,
          title: listing.title,
          source: listing.source,
          removed: listing.removed,
          iconUrl: listing.iconUrl ? webUrl(listing.iconUrl) : null,
          coverUrl: listing.coverUrl ? webUrl(listing.coverUrl) : null,
          gradient: listing.visual.gradient,
          initials: listing.visual.initials,
        })),
      }
    },
  }),
  endpoint({
    method: "POST",
    path: "/listings/app-store",
    auth: "onboarded",
    input: appStoreConnectInput,
    output: appStoreSyncOutput,
    run: async ({ db, user, input }) => {
      requireImports(user)
      await limitListingImport("app-store-connect", user.id)
      const summary = await connectAppStore(db, { userId: user.id, raw: input.appStore })
      await afterListingsChange(db, user.id, summary.listings)
      return summaryWire(summary)
    },
  }),
  endpoint({
    method: "POST",
    path: "/listings/app-store/refresh",
    auth: "onboarded",
    output: appStoreSyncOutput,
    run: async ({ db, user }) => {
      requireImports(user)
      await limitListingImport("app-store-refresh", user.id)
      const builderProfileId = await findBuilderProfileId(db, user.id)
      if (!builderProfileId) throw new ActionError(APP_STORE_MESSAGES.noProfile)
      const result = await syncAppStore(db, {
        builderProfileId,
        actorUserId: user.id,
        trigger: "manual",
      })
      if ("error" in result) throw new ActionError(refreshErrorMessage(result.error))
      await afterListingsChange(db, user.id, result.listings)
      return summaryWire(result)
    },
  }),
  endpoint({
    method: "POST",
    path: "/listings/app-store/verify",
    auth: "onboarded",
    output: appStoreVerifyOutput,
    run: async ({ db, user }) => {
      requireImports(user)
      await limitListingImport("app-store-verify", user.id)
      const result = await checkAppStoreVerification(db, { userId: user.id })
      if (!result.verified) throw new ActionError(APP_STORE_MESSAGES.codeMissing)
      return { verified: true }
    },
  }),
  endpoint({
    method: "DELETE",
    path: "/listings/app-store",
    auth: "onboarded",
    output: okSchema,
    run: async ({ db, user }) => {
      requireImports(user)
      await disconnectAppStore(db, { userId: user.id })
      return { ok: true }
    },
  }),
  endpoint({
    method: "POST",
    path: "/listings/web",
    auth: "onboarded",
    input: webImportInput,
    output: webImportOutput,
    run: async ({ db, user, input }) => {
      requireImports(user)
      await limitListingImport("web-listing-import", user.id)
      const result = await importWebListing(db, { userId: user.id, url: input.url })
      await afterListingsChange(db, user.id, [result])
      return { productId: result.productId, title: result.title, action: result.action }
    },
  }),
]

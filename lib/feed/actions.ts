"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { defineAction } from "@/lib/actions/define-action"
import { canBrowseFeed } from "@/lib/auth/authz"

import { recordFeedOpen, recordFeedShown, saveFeedListing, unsaveFeedListing } from "./interactions"

/**
 * The feed's server actions (CLAUDE.md §19.45). Authorized with `canBrowseFeed` (active creators);
 * every write is scoped to the signed-in user, and a listing the viewer may not see is a plain
 * "no longer available".
 */

const rank = z.coerce.number().int().min(1).max(10_000).nullable().optional().default(null)
const listingInput = z.object({
  productId: z.uuid({ error: "That listing link is not valid." }),
  rank,
  surface: z.enum(["feed", "profile"]).optional().default("feed"),
})

export const saveFeedListingAction = defineAction({
  name: "feed.save",
  input: listingInput,
  authorize: (user) => canBrowseFeed(user),
  run: async ({ input, user, db }) => {
    const result = await saveFeedListing(db, { userId: user.id, ...input })
    revalidatePath("/app/discover/saved")
    return result
  },
})

export const unsaveFeedListingAction = defineAction({
  name: "feed.unsave",
  input: listingInput,
  authorize: (user) => canBrowseFeed(user),
  run: async ({ input, user, db }) => {
    const result = await unsaveFeedListing(db, { userId: user.id, ...input })
    revalidatePath("/app/discover/saved")
    return result
  },
})

export const openFeedListingAction = defineAction({
  name: "feed.open",
  input: listingInput,
  authorize: (user) => canBrowseFeed(user),
  run: async ({ input, user, db }) => {
    await recordFeedOpen(db, { userId: user.id, ...input })
    return { ok: true }
  },
})

export const markFeedShownAction = defineAction({
  name: "feed.shown",
  input: z.object({
    page: z.coerce.number().int().min(1).max(1000),
    items: z
      .array(
        z.object({
          productId: z.uuid(),
          matchId: z.uuid().nullable(),
          rank: z.number().int().min(1).max(10_000),
        }),
      )
      .max(50),
  }),
  authorize: (user) => canBrowseFeed(user),
  run: async ({ input, user, db }) => recordFeedShown(db, { userId: user.id, ...input }),
})

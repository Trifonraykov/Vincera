"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canActOnMatch, canDiscover } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { runInBackground } from "@/lib/jobs/background"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"

import { explainMatches } from "./explain"
import {
  dismissMatch,
  markMatchesShown,
  MATCH_MESSAGES,
  recordMatchClick,
  saveMatch,
  unsaveMatch,
} from "./interactions"
import { findMatchesForAction, findMatchForAction } from "./queries"
import { recomputeMatchesForUser } from "./recompute"

/**
 * Discover's server actions (§12; CLAUDE.md §19.24 "Statuses", §19.27). Each is authorized with
 * `canActOnMatch` against the stored match: only the person it was computed for may act on it. A
 * missing match is a plain "no longer available", never "forbidden".
 */

const rank = z.coerce.number().int().min(1).max(1000).nullable().optional().default(null)
const matchInput = z.object({
  matchId: z.uuid({ error: "That match link is not valid." }),
  rank,
})

async function authorizeMatch(user: Parameters<typeof canActOnMatch>[0], matchId: string) {
  const match = await findMatchForAction(getDb(), matchId)
  if (!match) throw new ActionError(MATCH_MESSAGES.notFound)
  return canActOnMatch(user, match)
}

function revalidateDiscover(): void {
  revalidatePath("/app/discover", "layout")
  revalidatePath("/app")
}

export const saveMatchAction = defineAction({
  name: "matching.save",
  input: matchInput,
  authorize: (user, input) => authorizeMatch(user, input.matchId),
  run: async ({ input, user, db }) => {
    const result = await saveMatch(db, {
      userId: user.id,
      matchId: input.matchId,
      rank: input.rank,
    })
    revalidateDiscover()
    return result
  },
})

export const unsaveMatchAction = defineAction({
  name: "matching.unsave",
  input: matchInput,
  authorize: (user, input) => authorizeMatch(user, input.matchId),
  run: async ({ input, user, db }) => {
    const result = await unsaveMatch(db, {
      userId: user.id,
      matchId: input.matchId,
      rank: input.rank,
    })
    revalidateDiscover()
    return result
  },
})

export const dismissMatchAction = defineAction({
  name: "matching.dismiss",
  input: matchInput,
  authorize: (user, input) => authorizeMatch(user, input.matchId),
  run: async ({ input, user, db }) => {
    const result = await dismissMatch(db, {
      userId: user.id,
      matchId: input.matchId,
      rank: input.rank,
    })
    revalidateDiscover()
    return result
  },
})

/**
 * `match.shown` for the cards a page put on screen (batched per page view; once per row). Sent from
 * the browser after rendering, so a prefetch never counts as shown.
 */
export const markMatchesShownAction = defineAction({
  name: "matching.mark_shown",
  input: z.object({
    items: z
      .array(z.object({ matchId: z.uuid(), rank: z.number().int().min(1).max(1000) }))
      .min(1)
      .max(100),
  }),
  authorize: async (user, input) => {
    const rows = await findMatchesForAction(
      getDb(),
      input.items.map((item) => item.matchId),
    )
    return rows.length > 0 && rows.every((row) => canActOnMatch(user, row))
  },
  run: ({ input, user, db }) => markMatchesShown(db, { userId: user.id, items: input.items }),
})

/**
 * Open a match's card (`match.clicked`), then go to the idea, product or profile. A form action, so
 * it works without JavaScript and a prefetch never records a click.
 */
export const openMatchAction = defineAction({
  name: "matching.open",
  input: matchInput,
  authorize: (user, input) => authorizeMatch(user, input.matchId),
  run: async ({ input, user, db }) => {
    const href = await recordMatchClick(db, {
      userId: user.id,
      matchId: input.matchId,
      rank: input.rank,
    })
    redirect(href)
  },
})

/** `openMatchAction` for `<form action>` (which wants `Promise<void>`); a refusal re-renders. */
export async function openMatchFormAction(formData: FormData): Promise<void> {
  await openMatchAction(formData)
}

/** "Update my matches": a recompute now, a few times an hour per person. */
const MATCH_REFRESH_RATE_LIMIT: RateLimitRule = { limit: 5, window: "1 h" }

/**
 * "Update my matches" on Discover: recompute the person's lists now (one transaction, no model
 * calls, so it answers quickly) and write the explanations after the response. Until then the
 * cards show the template sentence.
 */
export const refreshMyMatchesAction = defineAction({
  name: "matching.refresh",
  input: z.object({ role: z.enum(["creator", "builder"]) }),
  authorize: (user, input) => canDiscover(user, input.role),
  run: async ({ user, db }) => {
    const limit = await rateLimit("matching-refresh", user.id, MATCH_REFRESH_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError("Your matches were just updated. Try again in a little while.")
    }
    const result = await recomputeMatchesForUser(db, user.id, { reason: "manual" })
    await runInBackground("matching", "explain", () => explainMatches(getDb(), result.pending))
    revalidateDiscover()
    return {
      stored: result.roles.reduce((sum, role) => sum + role.stored, 0),
    }
  },
})

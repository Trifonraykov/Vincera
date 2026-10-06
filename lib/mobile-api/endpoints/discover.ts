import "server-only"

import { z } from "zod"

import { canActOnMatch, canDiscover, canManageOwnAccount } from "@/lib/auth/authz"
import type { AuthUser } from "@/lib/auth/user"
import { listCollabsForUser } from "@/lib/collabs/queries"
import { collabNextStep } from "@/lib/collabs/display"
import type { Db } from "@/lib/db/client"
import { findProfileId } from "@/lib/embeddings/entities"
import { countOwnIdeas } from "@/lib/ideas/queries"
import {
  dismissMatch,
  markMatchesShown,
  MATCH_MESSAGES,
  recordMatchClick,
  saveMatch,
  unsaveMatch,
} from "@/lib/matching/interactions"
import {
  findMatchesForAction,
  findMatchForAction,
  listCurrentMatches,
  listOtherOpenBriefs,
  listSavedMatches,
  type MatchView,
} from "@/lib/matching/queries"
import { countOwnProducts } from "@/lib/products/queries"
import { listProposalsAwaitingUser } from "@/lib/proposals/queries"
import { loadOnboardingSnapshot } from "@/lib/onboarding/snapshot"
import { countUnreadNotifications } from "@/lib/notifications/center"
import { countUnreadMessages } from "@/lib/threads/queries"
import { revalidatePath } from "next/cache"

import { activeAppRole, webUrl } from "../context"
import { forbidden, MobileApiError } from "../errors"
import { endpoint, uuidParam, type Endpoint } from "../router"
import {
  DISCOVER_VIEW_VALUES,
  discoverOutput,
  homeOutput,
  markShownInput,
  markShownOutput,
  matchActionInput,
  matchActionOutput,
  matchClickOutput,
  type AppRole,
  type DiscoverView,
} from "../schemas"

/** Home and Discover (§12 `/app`, `/app/discover/*`; CLAUDE.md §19.27). */

const BRIEFS_PAGE_SIZE = 20

/** A match as the wire carries it (the card's web `href` is not part of the contract). */
export function matchWire(match: MatchView) {
  return {
    id: match.id,
    status: match.status,
    score: match.score,
    features: match.features,
    explanation: match.explanation,
    target: match.target,
  }
}

/** Which tabs each role has, as on the web (creators: Builders; builders: Briefs, Creators). */
const VIEWS_FOR_ROLE: Record<AppRole, readonly DiscoverView[]> = {
  creator: ["for_you", "builders", "saved"],
  builder: ["for_you", "briefs", "creators", "saved"],
}

function requireDiscoverRole(user: AuthUser): AppRole {
  const role = activeAppRole(user)
  if (!role || !canDiscover(user, role)) throw forbidden()
  return role
}

async function loadDiscover(db: Db, user: AuthUser, view: DiscoverView, page: number) {
  const role = requireDiscoverRole(user)
  if (!VIEWS_FOR_ROLE[role].includes(view)) {
    throw new MobileApiError(404, "not_found", "That list is not available for your role.")
  }
  const hasProfile = (await findProfileId(db, user.id, role)) !== null
  if (!hasProfile) return { role, view, hasProfile, matches: [] }
  switch (view) {
    case "saved":
      return {
        role,
        view,
        hasProfile,
        matches: (await listSavedMatches(db, user.id, role)).map(matchWire),
      }
    case "briefs": {
      const matched = await listCurrentMatches(db, user.id, "builder", { targetTypes: ["idea"] })
      const others = await listOtherOpenBriefs(db, user.id, {
        excludeIds: matched.map((match) => match.target.id),
        limit: BRIEFS_PAGE_SIZE,
        offset: (page - 1) * BRIEFS_PAGE_SIZE,
      })
      return {
        role,
        view,
        hasProfile,
        matches: matched.map(matchWire),
        otherBriefs: others.items,
      }
    }
    case "creators":
    case "builders":
      return {
        role,
        view,
        hasProfile,
        matches: (
          await listCurrentMatches(db, user.id, role, {
            targetTypes: [view === "creators" ? "creator" : "builder"],
          })
        ).map(matchWire),
      }
    case "for_you":
      return {
        role,
        view,
        hasProfile,
        matches: (await listCurrentMatches(db, user.id, role)).map(matchWire),
      }
  }
}

/** The stored match, checked with `canActOnMatch` like the web's Discover actions. */
async function authorizeMatch(db: Db, user: AuthUser, matchId: string): Promise<void> {
  const match = await findMatchForAction(db, matchId)
  if (!match) throw new MobileApiError(404, "not_found", MATCH_MESSAGES.notFound)
  if (!canActOnMatch(user, match)) throw forbidden()
}

function revalidateDiscover(): void {
  revalidatePath("/app/discover", "layout")
  revalidatePath("/app")
}

export const discoverEndpoints: Endpoint[] = [
  endpoint({
    method: "GET",
    path: "/home",
    auth: "onboarded",
    output: homeOutput,
    run: async ({ db, user }) => {
      if (!canManageOwnAccount(user)) throw forbidden()
      const role = activeAppRole(user)
      const [snapshot, proposalsAwaiting, collabs, notifications, messages] = await Promise.all([
        loadOnboardingSnapshot(db, user.id),
        listProposalsAwaitingUser(db, user.id, 3),
        listCollabsForUser(db, user.id, { activeOnly: true, limit: 3 }),
        countUnreadNotifications(db, user.id),
        countUnreadMessages(db, user.id),
      ])
      const hasProfile =
        role !== null &&
        snapshot !== null &&
        (role === "creator" ? snapshot.hasCreatorProfile : snapshot.hasBuilderProfile)
      const topMatches =
        role && hasProfile && canDiscover(user, role)
          ? await listCurrentMatches(db, user.id, role, { limit: 3 })
          : []
      let supply = { total: 0, live: 0 }
      if (role === "creator") {
        const counts = await countOwnIdeas(db, user.id)
        supply = { total: Object.values(counts).reduce((a, b) => a + b, 0), live: counts.open }
      } else if (role === "builder") {
        const counts = await countOwnProducts(db, user.id)
        supply = { total: Object.values(counts).reduce((a, b) => a + b, 0), live: counts.seeking }
      }
      return {
        role,
        hasProfile,
        payouts: snapshot?.payouts ?? "none",
        proposalsAwaiting,
        collabs: collabs.map((item) => ({ ...item, nextStep: collabNextStep(item) })),
        topMatches: topMatches.map(matchWire),
        supply,
        unread: { notifications, messages },
      }
    },
  }),
  endpoint({
    method: "GET",
    path: "/discover",
    auth: "onboarded",
    query: z.object({
      view: z.enum(DISCOVER_VIEW_VALUES).default("for_you"),
      page: z.coerce.number().int().min(1).max(500).default(1),
    }),
    output: discoverOutput,
    run: ({ db, user, query }) => loadDiscover(db, user, query.view, query.page),
  }),
  endpoint({
    method: "POST",
    path: "/discover/matches/:id/save",
    auth: "onboarded",
    input: matchActionInput,
    output: matchActionOutput,
    run: async ({ db, user, params, input }) => {
      const matchId = uuidParam(params)
      await authorizeMatch(db, user, matchId)
      const result = await saveMatch(db, { userId: user.id, matchId, rank: input.rank ?? null })
      revalidateDiscover()
      return { status: result.status }
    },
  }),
  endpoint({
    method: "POST",
    path: "/discover/matches/:id/unsave",
    auth: "onboarded",
    input: matchActionInput,
    output: matchActionOutput,
    run: async ({ db, user, params, input }) => {
      const matchId = uuidParam(params)
      await authorizeMatch(db, user, matchId)
      const result = await unsaveMatch(db, { userId: user.id, matchId, rank: input.rank ?? null })
      revalidateDiscover()
      return { status: result.status }
    },
  }),
  endpoint({
    method: "POST",
    path: "/discover/matches/:id/dismiss",
    auth: "onboarded",
    input: matchActionInput,
    output: matchActionOutput,
    run: async ({ db, user, params, input }) => {
      const matchId = uuidParam(params)
      await authorizeMatch(db, user, matchId)
      const result = await dismissMatch(db, { userId: user.id, matchId, rank: input.rank ?? null })
      revalidateDiscover()
      return { status: result.status }
    },
  }),
  endpoint({
    method: "POST",
    path: "/discover/matches/:id/click",
    auth: "onboarded",
    input: matchActionInput,
    output: matchClickOutput,
    run: async ({ db, user, params, input }) => {
      const matchId = uuidParam(params)
      const match = await findMatchForAction(db, matchId)
      if (!match) throw new MobileApiError(404, "not_found", MATCH_MESSAGES.notFound)
      if (!canActOnMatch(user, match)) throw forbidden()
      const href = await recordMatchClick(db, {
        userId: user.id,
        matchId,
        rank: input.rank ?? null,
      })
      return { target: { type: match.targetType, id: match.targetId }, webUrl: webUrl(href) }
    },
  }),
  endpoint({
    method: "POST",
    path: "/discover/shown",
    auth: "onboarded",
    input: markShownInput,
    output: markShownOutput,
    run: async ({ db, user, input }) => {
      // As the web's batched `match.shown`: every row must be the viewer's own.
      const rows = await findMatchesForAction(
        db,
        input.items.map((item) => item.matchId),
      )
      if (rows.length === 0 || !rows.every((row) => canActOnMatch(user, row))) throw forbidden()
      const result = await markMatchesShown(db, { userId: user.id, items: input.items })
      return { recorded: result.marked }
    },
  }),
]

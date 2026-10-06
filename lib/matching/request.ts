import "server-only"

import type { JobEventData } from "@/inngest/client"
import { enqueue } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"

/**
 * How other areas ask matching for work (CLAUDE.md §19.24 "Matching"). Both jobs are owned by
 * "matching" and debounced 10 minutes (per user, per target). Supply's embeddings job calls them
 * after re-embedding; nothing else needs to, except a change that affects candidacy without
 * touching an embedded entity (e.g. a user suspended in Phase 6).
 */

export type MatchingRecomputeReason = JobEventData<"matching/recompute.requested">["reason"]
export type MatchTargetType = JobEventData<"matching/target-changed.requested">["targetType"]

/** Rebuild `userId`'s own list (their profile changed, or they published an idea or product). */
export async function requestMatchingRecompute(input: {
  userId: string
  reason: MatchingRecomputeReason
}): Promise<void> {
  await enqueue("matching/recompute.requested", input)
}

/**
 * Re-score one target for everyone who may see it. `targetId` is a user id for `creator` /
 * `builder` targets, else the idea or product id (like `matches.target_id`).
 */
export async function requestTargetRescore(input: {
  targetType: MatchTargetType
  targetId: string
}): Promise<void> {
  await enqueue("matching/target-changed.requested", input)
}

/**
 * A person just became matchable, or changed in a way that affects candidacy without touching an
 * embedded field: onboarding finished (until then nobody can be matched with them, §19.27), or a
 * builder's availability changed. Rebuild their own lists and re-score them in everyone else's,
 * for each app role. Call after the commit. Never throws: an enqueue failure is reported, and the
 * nightly run catches up (CLAUDE.md §19.30).
 */
export async function requestMatchingForPerson(
  userId: string,
  roles: readonly ("creator" | "builder")[],
): Promise<void> {
  if (roles.length === 0) return
  try {
    await requestMatchingRecompute({ userId, reason: "profile_changed" })
    for (const role of roles) await requestTargetRescore({ targetType: role, targetId: userId })
  } catch (error) {
    reportError(error, { tags: { area: "matching", step: "enqueue_person" } })
  }
}

import "server-only"

import { and, eq } from "drizzle-orm"

import { now } from "@/lib/clock"
import type { Tx } from "@/lib/db/client"
import { collabs, type CollabEndReason, type CollabStage } from "@/lib/db/schema"
import { track } from "@/lib/events/track"

/**
 * Collab stage transitions (§5, CLAUDE.md §19.24 "Collabs"). Every change goes through
 * `changeCollabStage` so `stage_changed_at`, `last_activity_at`, the ended columns and the
 * `collab.stage_changed` / `collab.ended` events stay consistent.
 *
 *   agreement → building        both parties signed (collab: agreement signing)
 *   building → launch_review    both members approved the launch (Phase 4)
 *   launch_review → live        the launch went live (Phase 4)
 *   launch_review → building    the review sent the launch back for changes (Phase 4)
 *   any but ended → ended       exit, dispute or admin (Phase 6), with a reason
 *
 * Phase 4 and 6 may add transitions here (e.g. live → building); keep this table the one place.
 */
export const COLLAB_STAGE_TRANSITIONS: Readonly<Record<CollabStage, readonly CollabStage[]>> = {
  agreement: ["building", "ended"],
  building: ["launch_review", "ended"],
  launch_review: ["live", "building", "ended"],
  live: ["ended"],
  ended: [],
}

export function canChangeCollabStage(from: CollabStage, to: CollabStage): boolean {
  return COLLAB_STAGE_TRANSITIONS[from].includes(to)
}

export class CollabStageConflictError extends Error {
  constructor(collabId: string, from: CollabStage, to: CollabStage) {
    super(`Collab ${collabId} is not in stage "${from}" (wanted ${from} → ${to})`)
    this.name = "CollabStageConflictError"
  }
}

export type ChangeCollabStageInput = {
  collabId: string
  from: CollabStage
  to: CollabStage
  /** The member or admin who caused it; null for jobs and webhooks. */
  actorUserId: string | null
  /** Required when `to` is `ended`. */
  endedReason?: CollabEndReason
}

/**
 * Move a collab from `from` to `to` in the caller's transaction (a conditional update: it throws
 * `CollabStageConflictError` when the collab is no longer in `from`, e.g. a racing request, so the
 * caller's transaction rolls back) and emit the event.
 */
export async function changeCollabStage(tx: Tx, input: ChangeCollabStageInput): Promise<void> {
  const { collabId, from, to } = input
  if (!canChangeCollabStage(from, to))
    throw new Error(`Invalid collab stage change ${from} → ${to}`)
  if (to === "ended" && !input.endedReason) throw new Error("Ending a collab needs a reason")
  const at = now()
  const updated = await tx
    .update(collabs)
    .set({
      stage: to,
      stageChangedAt: at,
      lastActivityAt: at,
      ...(to === "ended" ? { endedAt: at, endedReason: input.endedReason } : {}),
    })
    .where(and(eq(collabs.id, collabId), eq(collabs.stage, from)))
    .returning({ id: collabs.id })
  if (updated.length === 0) throw new CollabStageConflictError(collabId, from, to)

  const base = {
    actorUserId: input.actorUserId,
    subjectType: "collab" as const,
    subjectId: collabId,
  }
  await track("collab.stage_changed", { ...base, properties: { from, to }, occurredAt: at }, tx)
  if (to === "ended") {
    const reason = input.endedReason ?? "admin"
    await track(
      "collab.ended",
      { ...base, properties: { from_stage: from, reason }, occurredAt: at },
      tx,
    )
  }
}

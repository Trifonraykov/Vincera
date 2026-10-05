import "server-only"

import { and, eq, gte } from "drizzle-orm"

import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { creatorProfiles, events } from "@/lib/db/schema"
import type { ProfileEditSource } from "@/lib/events/types"
import { track } from "@/lib/events/track"

import type { AudienceSummaryForm } from "./summary-form"

/**
 * The creator reviewing or editing their audience summary (§7.3, §11; CLAUDE.md §19.14).
 *
 * - Changed text or topics are stored with `audience_summary_edited_at`, so later syncs keep the
 *   creator's version (§19.11) until they choose "Regenerate"; `creator_profile.updated` lists the
 *   changed fields.
 * - When the current summary was AI-generated, `ai.reviewed` records the decision: accepted as is,
 *   or edited. (`ai.generated` was emitted at generation with `accepted_by_user: null`; events are
 *   append-only, so the decision is its own event.) One decision per generation: saving the same
 *   accepted text again (the review step, then /app/audience) records nothing new.
 */

export type SummaryReview = {
  profileId: string
  changed: boolean
  fields: ("audience_summary" | "topics")[]
}

export class CreatorProfileMissingError extends Error {
  constructor() {
    super("No creator profile")
    this.name = "CreatorProfileMissingError"
  }
}

function sameTopics(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((topic, index) => topic === b[index])
}

/** Whether the creator already recorded a decision on the summary generated at `generatedAt`. */
async function reviewedSince(
  database: DbOrTx,
  profileId: string,
  generatedAt: Date,
): Promise<boolean> {
  const [row] = await database
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.subjectId, profileId),
        eq(events.type, "ai.reviewed"),
        gte(events.occurredAt, generatedAt),
      ),
    )
    .limit(1)
  return row !== undefined
}

export async function reviewAudienceSummary(
  database: DbOrTx,
  input: { userId: string; form: AudienceSummaryForm; source: ProfileEditSource },
): Promise<SummaryReview> {
  return withTransaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, input.userId))
      .for("update")
    if (!profile) throw new CreatorProfileMissingError()

    const nextSummary = input.form.summary || null
    const fields: SummaryReview["fields"] = []
    if ((profile.audienceSummary ?? null) !== nextSummary) fields.push("audience_summary")
    if (!sameTopics(profile.topics, input.form.topics)) fields.push("topics")
    const changed = fields.length > 0

    // The text on screen came from the model and the creator had not replaced it yet.
    const wasGenerated =
      profile.audienceSummaryPromptVersion !== null &&
      profile.audienceSummaryGeneratedAt !== null &&
      profile.audienceSummaryEditedAt === null

    if (changed) {
      await tx
        .update(creatorProfiles)
        .set({
          audienceSummary: nextSummary,
          topics: input.form.topics,
          audienceSummaryEditedAt: now(),
        })
        .where(eq(creatorProfiles.id, profile.id))
      await track(
        "creator_profile.updated",
        {
          actorUserId: input.userId,
          subjectType: "creator_profile",
          subjectId: profile.id,
          properties: { fields, source: input.source },
        },
        tx,
      )
    }
    if (
      wasGenerated &&
      profile.audienceSummaryPromptVersion &&
      profile.audienceSummaryGeneratedAt &&
      !(await reviewedSince(tx, profile.id, profile.audienceSummaryGeneratedAt))
    ) {
      await track(
        "ai.reviewed",
        {
          actorUserId: input.userId,
          subjectType: "creator_profile",
          subjectId: profile.id,
          properties: {
            use: "audience_summary",
            prompt_version: profile.audienceSummaryPromptVersion,
            accepted: !changed,
            edited: changed,
          },
        },
        tx,
      )
    }
    return { profileId: profile.id, changed, fields }
  }, database)
}

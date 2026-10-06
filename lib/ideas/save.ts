import "server-only"

import { and, eq, getTableColumns, inArray } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { creatorProfiles, ideas, type IdeaStatus } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { SUPPLY_CURRENCY, type SupplyIntent } from "@/lib/supply/fields"
import {
  nextStatus,
  refusalMessage,
  statusesAllowing,
  type SupplyAction,
} from "@/lib/supply/lifecycle"
import { eventTopics, sameList } from "@/lib/supply/save-helpers"

import { reviewBrief, type BriefFields } from "./brief-review"
import { IDEA_COLUMNS, ideaPublishProblems, type IdeaFields } from "./fields"

/**
 * Writes for ideas (§5, §11 `idea.*`; lifecycle in lib/supply/lifecycle.ts, CLAUDE.md §19.24 /
 * §19.25). Each function is one transaction holding the change and its events. Authorization is
 * the caller's (`canCreateIdea` / `canManageIdea`); these functions still refuse rows the user
 * does not own, so a mistake there cannot edit someone else's idea. After the commit the caller
 * asks for an embedding refresh (lib/embeddings/request.ts) and revalidates pages.
 */

/** A brief the creator drafted with AI and saved from (verified by the caller). */
export type BriefUse = { promptVersion: string; draft: BriefFields }

export type IdeaWriteResult = {
  ideaId: string
  status: IdeaStatus
  /** Changed columns (snake_case); every column on create. */
  fields: string[]
  published: boolean
}

function columnsOf(fields: IdeaFields) {
  return {
    title: fields.title,
    problem: fields.problem,
    audienceEvidence: fields.audienceEvidence,
    format: fields.format,
    targetPriceCents: fields.targetPrice,
    topics: fields.topics,
  }
}

const COLUMN_NAMES: Record<keyof ReturnType<typeof columnsOf>, string> = {
  title: IDEA_COLUMNS.title,
  problem: IDEA_COLUMNS.problem,
  audienceEvidence: IDEA_COLUMNS.audienceEvidence,
  format: IDEA_COLUMNS.format,
  targetPriceCents: IDEA_COLUMNS.targetPrice,
  topics: IDEA_COLUMNS.topics,
}

function briefFieldsOf(fields: IdeaFields): BriefFields {
  return {
    title: fields.title,
    problem: fields.problem,
    audienceEvidence: fields.audienceEvidence,
    format: fields.format,
    targetPriceCents: fields.targetPrice,
    topics: fields.topics,
  }
}

function assertPublishable(fields: Pick<IdeaFields, "problem" | "topics">): void {
  const problems = ideaPublishProblems(fields)
  if (Object.keys(problems).length > 0) {
    throw new ActionError("Finish these before publishing.", { fieldErrors: problems })
  }
}

/** A new idea, saved as a draft or published at once (`intent`). */
export async function createIdea(
  database: DbOrTx,
  input: { userId: string; fields: IdeaFields; intent: SupplyIntent; brief?: BriefUse | null },
): Promise<IdeaWriteResult> {
  const publish = input.intent === "publish"
  if (publish) assertPublishable(input.fields)

  return withTransaction(async (tx) => {
    const [profile] = await tx
      .select({ id: creatorProfiles.id })
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, input.userId))
      .limit(1)
    if (!profile) throw new ActionError("Create your creator profile first.")

    const at = now()
    const status: IdeaStatus = publish ? "open" : "draft"
    const [idea] = await tx
      .insert(ideas)
      .values({
        creatorProfileId: profile.id,
        ...columnsOf(input.fields),
        currency: SUPPLY_CURRENCY,
        status,
        publishedAt: publish ? at : null,
      })
      .returning({ id: ideas.id })
    if (!idea) throw new Error("createIdea: no row returned")

    const subject = { actorUserId: input.userId, subjectType: "idea", subjectId: idea.id } as const
    await track(
      "idea.created",
      {
        ...subject,
        properties: {
          format: input.fields.format,
          topics: eventTopics(input.fields.topics),
          target_price_cents: input.fields.targetPrice,
        },
      },
      tx,
    )
    if (publish) await track("idea.published", { ...subject, properties: {} }, tx)
    if (input.brief) {
      // The creator's decision on the AI brief (§19.25: "saved largely unchanged").
      const review = reviewBrief(input.brief.draft, briefFieldsOf(input.fields))
      await track(
        "ai.reviewed",
        {
          ...subject,
          properties: {
            use: "idea_brief",
            prompt_version: input.brief.promptVersion,
            accepted: review.accepted,
            edited: review.edited,
          },
        },
        tx,
      )
    }
    return {
      ideaId: idea.id,
      status,
      fields: Object.values(IDEA_COLUMNS),
      published: publish,
    }
  }, database)
}

type LockedIdea = Omit<typeof ideas.$inferSelect, "embedding"> & { ownerUserId: string }

/** Every column but the vector (1024 numbers the writes never need). */
const { embedding: _embedding, ...ideaColumns } = getTableColumns(ideas)

async function lockOwnIdea(tx: Tx, userId: string, ideaId: string): Promise<LockedIdea> {
  const [row] = await tx
    .select({ idea: ideaColumns, ownerUserId: creatorProfiles.userId })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .where(eq(ideas.id, ideaId))
    .for("update", { of: ideas })
  if (!row || row.ownerUserId !== userId) throw new ActionError("This idea no longer exists.")
  return { ...row.idea, ownerUserId: row.ownerUserId }
}

/**
 * Save the form on `/app/ideas/[id]`. With `intent: "publish"` a draft is published in the same
 * transaction (`idea.updated` then `idea.published`); on a published idea it just saves.
 */
export async function updateIdea(
  database: DbOrTx,
  input: { userId: string; ideaId: string; fields: IdeaFields; intent: SupplyIntent },
): Promise<IdeaWriteResult> {
  return withTransaction(async (tx) => {
    const current = await lockOwnIdea(tx, input.userId, input.ideaId)
    if (nextStatus("idea", current.status, "edit") === null) {
      throw new ActionError(refusalMessage("idea", current.status, "edit"))
    }
    const publish = input.intent === "publish" && current.status === "draft"
    if (publish) assertPublishable(input.fields)

    const next = columnsOf(input.fields)
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) => {
      const before = current[key]
      const after = next[key]
      return Array.isArray(before) && Array.isArray(after)
        ? !sameList(before, after)
        : before !== after
    })
    const fields = changed.map((key) => COLUMN_NAMES[key])
    if (changed.length === 0 && !publish) {
      return { ideaId: current.id, status: current.status, fields: [], published: false }
    }

    const at = now()
    const status: IdeaStatus = publish ? "open" : current.status
    await tx
      .update(ideas)
      .set({ ...next, status, ...(publish ? { publishedAt: at } : {}) })
      .where(eq(ideas.id, current.id))

    const subject = {
      actorUserId: input.userId,
      subjectType: "idea",
      subjectId: current.id,
    } as const
    if (fields.length > 0) await track("idea.updated", { ...subject, properties: { fields } }, tx)
    if (publish) await track("idea.published", { ...subject, properties: {} }, tx)
    return { ideaId: current.id, status, fields, published: publish }
  }, database)
}

export type IdeaTransition = Exclude<SupplyAction, "edit">

/**
 * Publish, archive or restore an idea (the buttons outside the form). A conditional update on
 * the statuses the action may start from, under the row lock, so a racing change (e.g. a collab
 * that just took the idea) loses cleanly with a plain message.
 */
export async function transitionIdea(
  database: DbOrTx,
  input: { userId: string; ideaId: string; action: IdeaTransition },
): Promise<{ ideaId: string; from: IdeaStatus; status: IdeaStatus }> {
  return withTransaction(async (tx) => {
    const current = await lockOwnIdea(tx, input.userId, input.ideaId)
    const status = nextStatus("idea", current.status, input.action)
    if (status === null) throw new ActionError(refusalMessage("idea", current.status, input.action))
    if (input.action === "publish") assertPublishable(current)

    const at = now()
    const moved = await tx
      .update(ideas)
      .set({
        status,
        ...(input.action === "publish" ? { publishedAt: at } : {}),
        ...(input.action === "archive" ? { archivedAt: at } : {}),
        ...(input.action === "restore" ? { archivedAt: null } : {}),
      })
      .where(
        and(
          eq(ideas.id, current.id),
          inArray(ideas.status, statusesAllowing("idea", input.action)),
        ),
      )
      .returning({ id: ideas.id })
    if (moved.length === 0)
      throw new ActionError(refusalMessage("idea", current.status, input.action))

    const subject = {
      actorUserId: input.userId,
      subjectType: "idea",
      subjectId: current.id,
    } as const
    switch (input.action) {
      case "publish":
        await track("idea.published", { ...subject, properties: {} }, tx)
        break
      case "archive":
        await track(
          "idea.archived",
          { ...subject, properties: { from_status: current.status } },
          tx,
        )
        break
      case "restore":
        await track("idea.restored", { ...subject, properties: {} }, tx)
        break
    }
    return { ideaId: current.id, from: current.status, status }
  }, database)
}

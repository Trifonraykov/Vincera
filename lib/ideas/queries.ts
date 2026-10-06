import "server-only"

import { and, count, desc, eq, inArray } from "drizzle-orm"

import type { IdeaAccess } from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import { creatorProfiles, ideas, type IdeaStatus } from "@/lib/db/schema"
import { statusesForFilter, type SupplyFilter } from "@/lib/supply/lifecycle"

/**
 * Reads for `/app/ideas`, `/app/ideas/[id]` and the idea actions. Every read that a page shows to
 * someone other than the owner goes through `canViewIdea` first (the page does it).
 */

const ideaColumns = {
  id: ideas.id,
  creatorProfileId: ideas.creatorProfileId,
  title: ideas.title,
  problem: ideas.problem,
  audienceEvidence: ideas.audienceEvidence,
  format: ideas.format,
  targetPriceCents: ideas.targetPriceCents,
  currency: ideas.currency,
  topics: ideas.topics,
  status: ideas.status,
  publishedAt: ideas.publishedAt,
  archivedAt: ideas.archivedAt,
  createdAt: ideas.createdAt,
  updatedAt: ideas.updatedAt,
} as const

export type IdeaRecord = {
  id: string
  creatorProfileId: string
  title: string
  problem: string | null
  audienceEvidence: string | null
  format: (typeof ideas.$inferSelect)["format"]
  targetPriceCents: number | null
  currency: string
  topics: string[]
  status: IdeaStatus
  publishedAt: Date | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
  owner: { userId: string; handle: string; displayName: string }
}

/** One idea with its owner, or null for an unknown id. */
export async function findIdea(database: DbOrTx, ideaId: string): Promise<IdeaRecord | null> {
  const [row] = await database
    .select({
      ...ideaColumns,
      ownerUserId: creatorProfiles.userId,
      ownerHandle: creatorProfiles.handle,
      ownerDisplayName: creatorProfiles.displayName,
    })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .where(eq(ideas.id, ideaId))
    .limit(1)
  if (!row) return null
  const { ownerUserId, ownerHandle, ownerDisplayName, ...idea } = row
  return {
    ...idea,
    owner: { userId: ownerUserId, handle: ownerHandle, displayName: ownerDisplayName },
  }
}

/** What `canManageIdea` / `canViewIdea` need, or null for an unknown id. */
export async function findIdeaAccess(database: DbOrTx, ideaId: string): Promise<IdeaAccess | null> {
  const [row] = await database
    .select({ ownerUserId: creatorProfiles.userId, status: ideas.status })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .where(eq(ideas.id, ideaId))
    .limit(1)
  return row ?? null
}

export type IdeaListItem = Pick<
  IdeaRecord,
  | "id"
  | "title"
  | "format"
  | "targetPriceCents"
  | "currency"
  | "topics"
  | "status"
  | "publishedAt"
  | "updatedAt"
>

/** The creator's own ideas for the list page, newest change first. */
export async function listOwnIdeas(
  database: DbOrTx,
  userId: string,
  filter: SupplyFilter,
): Promise<IdeaListItem[]> {
  return database
    .select({
      id: ideas.id,
      title: ideas.title,
      format: ideas.format,
      targetPriceCents: ideas.targetPriceCents,
      currency: ideas.currency,
      topics: ideas.topics,
      status: ideas.status,
      publishedAt: ideas.publishedAt,
      updatedAt: ideas.updatedAt,
    })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .where(
      and(
        eq(creatorProfiles.userId, userId),
        inArray(ideas.status, statusesForFilter("idea", filter)),
      ),
    )
    .orderBy(desc(ideas.updatedAt), desc(ideas.id))
}

/** How many of the creator's ideas are in each status (the filter chips' counts). */
export async function countOwnIdeas(
  database: DbOrTx,
  userId: string,
): Promise<Record<IdeaStatus, number>> {
  const rows = await database
    .select({ status: ideas.status, total: count() })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .where(eq(creatorProfiles.userId, userId))
    .groupBy(ideas.status)
  const counts: Record<IdeaStatus, number> = {
    draft: 0,
    open: 0,
    in_collab: 0,
    launched: 0,
    archived: 0,
  }
  for (const row of rows) counts[row.status] = row.total
  return counts
}

/** The creator profile an idea belongs to, with the context the brief drafter uses. */
export async function findCreatorContext(database: DbOrTx, userId: string) {
  const [profile] = await database
    .select({
      id: creatorProfiles.id,
      niche: creatorProfiles.niche,
      topics: creatorProfiles.topics,
      audienceSummary: creatorProfiles.audienceSummary,
    })
    .from(creatorProfiles)
    .where(eq(creatorProfiles.userId, userId))
    .limit(1)
  return profile ?? null
}

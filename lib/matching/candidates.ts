import "server-only"

import { and, asc, eq, gt, ne, sql, type SQL } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  creatorProfiles,
  ideas,
  matches,
  products,
  users,
  type TargetType,
} from "@/lib/db/schema"

import { eligiblePersonSql, verifiedCreatorConnectionSql } from "./facts"
import type { IdeaFacts, ProductFacts } from "./features"

/**
 * Candidate generation (§8 "Candidates", CLAUDE.md §19.24):
 * - a creator sees `seeking` products and builders whose availability is not `closed`;
 * - a builder sees `open` ideas and creators with a verified connection;
 * - never themselves (their own products/ideas included), never a target they dismissed (under
 *   any model version), and only people who are active, onboarded and have the role's profile.
 *
 * pgvector prefilter: each pool is ordered by embedding distance to the subject (`<=>`, cosine
 * distance, HNSW-indexed) and capped at `CANDIDATE_POOL`; ideas, products and creators that share a
 * topic with the subject are added even when they are further away (`TOPIC_POOL`), because topic
 * overlap is the second-largest weight. While a pool has fewer eligible rows than the cap the
 * result is exact; beyond it the ranking is exact within the pool. The cosine itself is computed
 * in SQL (`1 - distance`), so vectors never leave the database.
 */

/** Nearest candidates per target type kept for full scoring (also `hnsw.ef_search`). */
export const CANDIDATE_POOL = 500
/** Extra topic-sharing candidates per target type, whatever their distance. */
export const TOPIC_POOL = 200

export type Candidate =
  | {
      targetType: "product"
      targetId: string
      ownerUserId: string
      cosine: number | null
      product: ProductFacts
    }
  | {
      targetType: "idea"
      targetId: string
      ownerUserId: string
      cosine: number | null
      idea: IdeaFacts
    }
  | { targetType: "builder"; targetId: string; ownerUserId: string; cosine: number | null }
  | { targetType: "creator"; targetId: string; ownerUserId: string; cosine: number | null }

/**
 * Let HNSW index scans return enough rows for a filtered pool (pgvector's default `ef_search` is
 * 40). Transaction-local; a no-op where the planner scans the table instead.
 */
export async function raiseEfSearch(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`SELECT set_config('hnsw.ef_search', ${String(CANDIDATE_POOL)}, true)`)
}

function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`
}

function notDismissed(subjectUserId: string, targetType: TargetType, targetId: SQL | unknown): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${matches}
    WHERE ${matches.subjectUserId} = ${subjectUserId}
      AND ${matches.targetType} = ${targetType}
      AND ${matches.targetId} = ${targetId}
      AND ${matches.status} = 'dismissed'
  )`
}

/** `(SELECT embedding FROM <role>_profiles WHERE user_id = $1)`: the subject's vector, in SQL. */
function subjectEmbedding(role: "creator" | "builder", userId: string): SQL {
  return role === "creator"
    ? sql`(SELECT ${creatorProfiles.embedding} FROM ${creatorProfiles} WHERE ${creatorProfiles.userId} = ${userId})`
    : sql`(SELECT ${builderProfiles.embedding} FROM ${builderProfiles} WHERE ${builderProfiles.userId} = ${userId})`
}

function cosineOf(column: SQL | typeof products.embedding, other: SQL): SQL<number | null> {
  return sql<number | null>`(1 - (${column} <=> ${other}))::float8`
}

function priceOf(cents: number | null, currency: string) {
  return cents === null ? null : { cents, currency }
}

/** Merge the distance pool and the topic pool, keeping the first occurrence. */
function mergePools<T extends { targetId: string }>(...pools: T[][]): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const pool of pools) {
    for (const row of pool) {
      if (seen.has(row.targetId)) continue
      seen.add(row.targetId)
      merged.push(row)
    }
  }
  return merged
}

async function productCandidates(
  tx: DbOrTx,
  subjectUserId: string,
  subjectTopics: readonly string[],
): Promise<Candidate[]> {
  const vector = subjectEmbedding("creator", subjectUserId)
  const distance = sql`${products.embedding} <=> ${vector}`
  const base = () =>
    tx
      .select({
        targetId: products.id,
        ownerUserId: builderProfiles.userId,
        cosine: cosineOf(products.embedding, vector),
        format: products.format,
        stage: products.stage,
        cents: products.targetPriceCents,
        currency: products.currency,
        topics: products.topics,
      })
      .from(products)
      .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
      .innerJoin(users, eq(users.id, builderProfiles.userId))
  const where = (extra?: SQL) =>
    and(
      eq(products.status, "seeking"),
      ne(builderProfiles.userId, subjectUserId),
      eligiblePersonSql("builder"),
      notDismissed(subjectUserId, "product", products.id),
      extra,
    )
  const near = await base()
    .where(where())
    .orderBy(sql`${distance} ASC NULLS LAST`, asc(products.id))
    .limit(CANDIDATE_POOL)
  // One query at a time: `tx` is a single connection.
  const topical =
    subjectTopics.length > 0
      ? await base()
          .where(where(sql`${products.topics} && ${textArray(subjectTopics)}`))
          .orderBy(asc(products.id))
          .limit(TOPIC_POOL)
      : []
  return mergePools(near, topical).map((row) => ({
    targetType: "product" as const,
    targetId: row.targetId,
    ownerUserId: row.ownerUserId,
    cosine: row.cosine === null ? null : Number(row.cosine),
    product: {
      format: row.format,
      stage: row.stage,
      price: priceOf(row.cents, row.currency),
      topics: row.topics,
    },
  }))
}

async function ideaCandidates(
  tx: DbOrTx,
  subjectUserId: string,
  subjectTopics: readonly string[],
): Promise<Candidate[]> {
  const vector = subjectEmbedding("builder", subjectUserId)
  const distance = sql`${ideas.embedding} <=> ${vector}`
  const base = () =>
    tx
      .select({
        targetId: ideas.id,
        ownerUserId: creatorProfiles.userId,
        cosine: cosineOf(sql`${ideas.embedding}`, vector),
        format: ideas.format,
        cents: ideas.targetPriceCents,
        currency: ideas.currency,
        topics: ideas.topics,
      })
      .from(ideas)
      .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
      .innerJoin(users, eq(users.id, creatorProfiles.userId))
  const where = (extra?: SQL) =>
    and(
      eq(ideas.status, "open"),
      ne(creatorProfiles.userId, subjectUserId),
      eligiblePersonSql("creator"),
      notDismissed(subjectUserId, "idea", ideas.id),
      extra,
    )
  const near = await base()
    .where(where())
    .orderBy(sql`${distance} ASC NULLS LAST`, asc(ideas.id))
    .limit(CANDIDATE_POOL)
  // One query at a time: `tx` is a single connection.
  const topical =
    subjectTopics.length > 0
      ? await base()
          .where(where(sql`${ideas.topics} && ${textArray(subjectTopics)}`))
          .orderBy(asc(ideas.id))
          .limit(TOPIC_POOL)
      : []
  return mergePools(near, topical).map((row) => ({
    targetType: "idea" as const,
    targetId: row.targetId,
    ownerUserId: row.ownerUserId,
    cosine: row.cosine === null ? null : Number(row.cosine),
    idea: { format: row.format, price: priceOf(row.cents, row.currency), topics: row.topics },
  }))
}

async function builderCandidates(tx: DbOrTx, subjectUserId: string): Promise<Candidate[]> {
  const vector = subjectEmbedding("creator", subjectUserId)
  const rows = await tx
    .select({
      targetId: builderProfiles.userId,
      cosine: cosineOf(sql`${builderProfiles.embedding}`, vector),
    })
    .from(builderProfiles)
    .innerJoin(users, eq(users.id, builderProfiles.userId))
    .where(
      and(
        ne(builderProfiles.availability, "closed"),
        ne(builderProfiles.userId, subjectUserId),
        eligiblePersonSql("builder"),
        notDismissed(subjectUserId, "builder", builderProfiles.userId),
      ),
    )
    .orderBy(
      sql`${builderProfiles.embedding} <=> ${vector} ASC NULLS LAST`,
      asc(builderProfiles.userId),
    )
    .limit(CANDIDATE_POOL)
  return rows.map((row) => ({
    targetType: "builder" as const,
    targetId: row.targetId,
    ownerUserId: row.targetId,
    cosine: row.cosine === null ? null : Number(row.cosine),
  }))
}

async function creatorCandidates(
  tx: DbOrTx,
  subjectUserId: string,
  subjectTopics: readonly string[],
): Promise<Candidate[]> {
  const vector = subjectEmbedding("builder", subjectUserId)
  const base = () =>
    tx
      .select({
        targetId: creatorProfiles.userId,
        cosine: cosineOf(sql`${creatorProfiles.embedding}`, vector),
      })
      .from(creatorProfiles)
      .innerJoin(users, eq(users.id, creatorProfiles.userId))
  const where = (extra?: SQL) =>
    and(
      ne(creatorProfiles.userId, subjectUserId),
      eligiblePersonSql("creator"),
      verifiedCreatorConnectionSql(creatorProfiles.userId),
      notDismissed(subjectUserId, "creator", creatorProfiles.userId),
      extra,
    )
  const near = await base()
    .where(where())
    .orderBy(
      sql`${creatorProfiles.embedding} <=> ${vector} ASC NULLS LAST`,
      asc(creatorProfiles.userId),
    )
    .limit(CANDIDATE_POOL)
  // One query at a time: `tx` is a single connection.
  const topical =
    subjectTopics.length > 0
      ? await base()
          .where(where(sql`${creatorProfiles.topics} && ${textArray(subjectTopics)}`))
          .orderBy(asc(creatorProfiles.userId))
          .limit(TOPIC_POOL)
      : []
  return mergePools(near, topical).map((row) => ({
    targetType: "creator" as const,
    targetId: row.targetId,
    ownerUserId: row.targetId,
    cosine: row.cosine === null ? null : Number(row.cosine),
  }))
}

/** The candidate pool of one target type for a subject (see the header). */
export async function candidatesFor(
  tx: DbOrTx,
  subjectUserId: string,
  targetType: TargetType,
  subjectTopics: readonly string[],
): Promise<Candidate[]> {
  switch (targetType) {
    case "product":
      return productCandidates(tx, subjectUserId, subjectTopics)
    case "builder":
      return builderCandidates(tx, subjectUserId)
    case "idea":
      return ideaCandidates(tx, subjectUserId, subjectTopics)
    case "creator":
      return creatorCandidates(tx, subjectUserId, subjectTopics)
  }
}

// --- One target, many subjects (target rescore) ------------------------------------------------

/** A target as the rescore needs it: whether it is still a candidate at all, and its facts. */
export type RescoreTarget =
  | {
      targetType: "product"
      targetId: string
      ownerUserId: string
      eligible: boolean
      product: ProductFacts
    }
  | {
      targetType: "idea"
      targetId: string
      ownerUserId: string
      eligible: boolean
      idea: IdeaFacts
    }
  | { targetType: "builder"; targetId: string; ownerUserId: string; eligible: boolean }
  | { targetType: "creator"; targetId: string; ownerUserId: string; eligible: boolean }

/** Load a target by type and id; null when it does not exist. */
export async function loadRescoreTarget(
  database: DbOrTx,
  targetType: TargetType,
  targetId: string,
): Promise<RescoreTarget | null> {
  switch (targetType) {
    case "product": {
      const [row] = await database
        .select({
          ownerUserId: builderProfiles.userId,
          status: products.status,
          format: products.format,
          stage: products.stage,
          cents: products.targetPriceCents,
          currency: products.currency,
          topics: products.topics,
          ownerEligible: sql<boolean>`(${eligiblePersonSql("builder")})`,
        })
        .from(products)
        .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
        .innerJoin(users, eq(users.id, builderProfiles.userId))
        .where(eq(products.id, targetId))
      if (!row) return null
      return {
        targetType,
        targetId,
        ownerUserId: row.ownerUserId,
        eligible: row.status === "seeking" && Boolean(row.ownerEligible),
        product: {
          format: row.format,
          stage: row.stage,
          price: priceOf(row.cents, row.currency),
          topics: row.topics,
        },
      }
    }
    case "idea": {
      const [row] = await database
        .select({
          ownerUserId: creatorProfiles.userId,
          status: ideas.status,
          format: ideas.format,
          cents: ideas.targetPriceCents,
          currency: ideas.currency,
          topics: ideas.topics,
          ownerEligible: sql<boolean>`(${eligiblePersonSql("creator")})`,
        })
        .from(ideas)
        .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
        .innerJoin(users, eq(users.id, creatorProfiles.userId))
        .where(eq(ideas.id, targetId))
      if (!row) return null
      return {
        targetType,
        targetId,
        ownerUserId: row.ownerUserId,
        eligible: row.status === "open" && Boolean(row.ownerEligible),
        idea: { format: row.format, price: priceOf(row.cents, row.currency), topics: row.topics },
      }
    }
    case "builder": {
      const [row] = await database
        .select({
          availability: builderProfiles.availability,
          eligible: sql<boolean>`(${eligiblePersonSql("builder")})`,
        })
        .from(builderProfiles)
        .innerJoin(users, eq(users.id, builderProfiles.userId))
        .where(eq(builderProfiles.userId, targetId))
      if (!row) return null
      return {
        targetType,
        targetId,
        ownerUserId: targetId,
        eligible: row.availability !== "closed" && Boolean(row.eligible),
      }
    }
    case "creator": {
      const [row] = await database
        .select({
          eligible: sql<boolean>`(${eligiblePersonSql("creator")} AND ${verifiedCreatorConnectionSql(creatorProfiles.userId)})`,
        })
        .from(creatorProfiles)
        .innerJoin(users, eq(users.id, creatorProfiles.userId))
        .where(eq(creatorProfiles.userId, targetId))
      if (!row) return null
      return { targetType, targetId, ownerUserId: targetId, eligible: Boolean(row.eligible) }
    }
  }
}

/** The target's own vector, in SQL. */
function targetEmbedding(target: RescoreTarget): SQL {
  switch (target.targetType) {
    case "product":
      return sql`(SELECT ${products.embedding} FROM ${products} WHERE ${products.id} = ${target.targetId})`
    case "idea":
      return sql`(SELECT ${ideas.embedding} FROM ${ideas} WHERE ${ideas.id} = ${target.targetId})`
    case "builder":
      return subjectEmbedding("builder", target.targetId)
    case "creator":
      return subjectEmbedding("creator", target.targetId)
  }
}

export type RescoreSubject = { userId: string; cosine: number | null }

/**
 * One page (by user id) of the people who may see `target`: eligible people of the other role,
 * not its owner, who have not dismissed it, with the cosine between their profile and the target.
 */
export async function subjectsForTarget(
  database: DbOrTx,
  target: RescoreTarget,
  afterUserId: string | null,
  limit: number,
): Promise<RescoreSubject[]> {
  const vector = targetEmbedding(target)
  const subjectRole =
    target.targetType === "product" || target.targetType === "builder" ? "creator" : "builder"
  const profile = subjectRole === "creator" ? creatorProfiles : builderProfiles
  const rows = await database
    .select({
      userId: profile.userId,
      cosine: cosineOf(sql`${profile.embedding}`, vector),
    })
    .from(profile)
    .innerJoin(users, eq(users.id, profile.userId))
    .where(
      and(
        ne(profile.userId, target.ownerUserId),
        eligiblePersonSql(subjectRole),
        sql`NOT EXISTS (
          SELECT 1 FROM ${matches}
          WHERE ${matches.subjectUserId} = ${profile.userId}
            AND ${matches.targetType} = ${target.targetType}
            AND ${matches.targetId} = ${target.targetId}
            AND ${matches.status} = 'dismissed'
        )`,
        afterUserId ? gt(profile.userId, afterUserId) : undefined,
      ),
    )
    .orderBy(asc(profile.userId))
    .limit(limit)
  return rows.map((row) => ({
    userId: row.userId,
    cosine: row.cosine === null ? null : Number(row.cosine),
  }))
}

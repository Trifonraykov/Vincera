import "server-only"

import { and, eq, inArray, isNull } from "drizzle-orm"

import type { ClaudeDeps } from "@/lib/ai/claude"
import { embed, EmbeddingError, type EmbedDeps } from "@/lib/ai/embed"
import {
  generateAudienceSummary,
  hasAudienceData,
  type AudienceSummaryInput,
} from "@/lib/ai/prompts/audience-summary"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { creatorProfiles, socialConnections, type SizeTier } from "@/lib/db/schema"
import { env, isFake } from "@/lib/env"
import { track } from "@/lib/events/track"
import { reportError } from "@/lib/observability"

import { latestSnapshotsFor } from "./queries"
import { recentContentTitles } from "./raw"
import { computeSizeTier, type SizeTierResult } from "./size-tier"
import { CREATOR_SOCIAL_PROVIDERS } from "./types"

/**
 * A creator's fields derived from their social data (§5, §7.1 sync flow): `size_tier`, the
 * AI `audience_summary` + `topics`, and the profile `embedding`. Recomputed after every sync, a
 * manual entry, a disconnect and an admin verification (CLAUDE.md §19.14).
 *
 * The summary never blocks anything (§7.3): a failed generation keeps the existing summary, and a
 * summary the creator edited (`audience_summary_edited_at`) is kept until they regenerate it.
 * Embedding failures are reported and keep the old vector.
 */

type CreatorProfileRow = typeof creatorProfiles.$inferSelect

async function findCreatorProfile(
  database: DbOrTx,
  userId: string,
): Promise<CreatorProfileRow | null> {
  const [profile] = await database
    .select()
    .from(creatorProfiles)
    .where(eq(creatorProfiles.userId, userId))
    .limit(1)
  return profile ?? null
}

/** The user's creator connections (YouTube, Instagram, TikTok; not revoked) with latest data. */
async function creatorConnections(database: DbOrTx, userId: string) {
  const connections = await database
    .select({
      id: socialConnections.id,
      provider: socialConnections.provider,
      status: socialConnections.status,
      verifiedAt: socialConnections.verifiedAt,
    })
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.userId, userId),
        inArray(socialConnections.provider, [...CREATOR_SOCIAL_PROVIDERS]),
      ),
    )
  const usable = connections.filter((connection) => connection.status !== "revoked")
  const latest = await latestSnapshotsFor(
    database,
    usable.map((connection) => connection.id),
  )
  return usable.map((connection) => ({ ...connection, latest: latest.get(connection.id) ?? null }))
}

// --- Size tier ---------------------------------------------------------------------------------

export type SizeTierUpdate = SizeTierResult & {
  /** Null when the user has no creator profile (nothing stored). */
  profileId: string | null
  changed: boolean
}

/**
 * Recompute `creator_profiles.size_tier` from the newest snapshot of each creator connection,
 * preferring verified connections (lib/social/size-tier.ts). Pass the transaction of the change
 * that triggered it (a new snapshot, a disconnect, a verification).
 */
export async function recomputeSizeTier(database: DbOrTx, userId: string): Promise<SizeTierUpdate> {
  const profile = await findCreatorProfile(database, userId)
  const connections = await creatorConnections(database, userId)
  const result = computeSizeTier(
    connections.map((connection) => ({
      status: connection.status,
      verified: connection.verifiedAt !== null,
      followers: connection.latest?.followers ?? null,
    })),
  )
  if (!profile) return { ...result, profileId: null, changed: false }
  const changed = profile.sizeTier !== result.tier
  if (changed) {
    await database
      .update(creatorProfiles)
      .set({ sizeTier: result.tier })
      .where(eq(creatorProfiles.id, profile.id))
  }
  return { ...result, profileId: profile.id, changed }
}

// --- Audience summary --------------------------------------------------------------------------

/** What the summary prompt gets: profile facts plus aggregates per connection (no names). */
export async function buildAudienceSummaryInput(
  database: DbOrTx,
  userId: string,
  profile: Pick<CreatorProfileRow, "niche" | "topics" | "languages" | "country">,
): Promise<AudienceSummaryInput> {
  const connections = await creatorConnections(database, userId)
  return {
    niche: profile.niche,
    profileTopics: profile.topics,
    languages: profile.languages,
    country: profile.country,
    connections: connections.flatMap(({ provider, verifiedAt, latest }) =>
      latest
        ? [
            {
              provider,
              verified: verifiedAt !== null,
              followers: latest.followers,
              avgViews: latest.avgViews,
              engagementRate: latest.engagementRate,
              topCountries: latest.topCountries ?? [],
              countriesBasis: latest.countriesBasis,
              ageGender: latest.ageGender,
              topTopics: latest.topTopics,
              recentTitles: recentContentTitles(provider, latest.raw),
            },
          ]
        : [],
    ),
  }
}

export type SummaryOutcome =
  /** New summary and topics stored. */
  | "generated"
  /** The model failed; the old summary was kept (§7.3). */
  | "fallback"
  /** The creator's own edit was kept. */
  | "kept_edited"
  /** No audience data to summarise yet; nothing was called. */
  | "no_data"
  | "no_profile"

export type RefreshSummaryOptions = {
  /**
   * "Regenerate": replace even a summary the creator edited, and clear
   * `audience_summary_edited_at` so later syncs keep it up to date again.
   */
  force?: boolean
  /** The user who asked (Regenerate); null for syncs and jobs. */
  actorUserId?: string | null
  ai?: ClaudeDeps
}

/**
 * Regenerate the creator's audience summary and topics (lib/ai/prompts/audience-summary.ts) and
 * emit `ai.generated` (accepted_by_user unknown: the creator reviews it later, `ai.reviewed`).
 * The model call happens outside any transaction.
 */
export async function refreshAudienceSummary(
  database: DbOrTx,
  userId: string,
  options: RefreshSummaryOptions = {},
): Promise<{ outcome: SummaryOutcome; promptVersion: string | null }> {
  const profile = await findCreatorProfile(database, userId)
  if (!profile) return { outcome: "no_profile", promptVersion: null }
  if (profile.audienceSummaryEditedAt && !options.force) {
    return { outcome: "kept_edited", promptVersion: profile.audienceSummaryPromptVersion }
  }

  const input = await buildAudienceSummaryInput(database, userId, profile)
  if (!hasAudienceData(input)) {
    return { outcome: "no_data", promptVersion: profile.audienceSummaryPromptVersion }
  }

  const result = await generateAudienceSummary(input, options.ai)

  return withTransaction(async (tx) => {
    let outcome: SummaryOutcome = "fallback"
    if (result.ok) {
      const stored = await tx
        .update(creatorProfiles)
        .set({
          audienceSummary: result.data.summary,
          topics: result.data.topics,
          audienceSummaryPromptVersion: result.promptVersion,
          audienceSummaryGeneratedAt: now(),
          ...(options.force ? { audienceSummaryEditedAt: null } : {}),
        })
        .where(
          options.force
            ? eq(creatorProfiles.id, profile.id)
            : // The creator may have edited it while the model was running: theirs wins.
              and(
                eq(creatorProfiles.id, profile.id),
                isNull(creatorProfiles.audienceSummaryEditedAt),
              ),
        )
        .returning({ id: creatorProfiles.id })
      outcome = stored.length > 0 ? "generated" : "kept_edited"
    }
    await track(
      "ai.generated",
      {
        actorUserId: options.actorUserId ?? null,
        subjectType: "creator_profile",
        subjectId: profile.id,
        properties: {
          use: "audience_summary",
          prompt_version: result.promptVersion,
          model: result.model,
          latency_ms: result.latencyMs,
          accepted_by_user: null,
          fallback: !result.ok,
        },
      },
      tx,
    )
    return {
      outcome,
      promptVersion:
        outcome === "generated" ? result.promptVersion : profile.audienceSummaryPromptVersion,
    }
  }, database)
}

// --- Embedding ---------------------------------------------------------------------------------

/**
 * The text a creator profile is embedded from (§8 `semantic`): what the creator makes and who
 * watches it. No names, handles or emails.
 */
export function creatorProfileEmbeddingText(
  profile: Pick<
    CreatorProfileRow,
    "niche" | "bio" | "topics" | "languages" | "country" | "audienceSummary"
  >,
): string {
  const lines = [
    profile.niche ? `Niche: ${profile.niche}` : null,
    profile.topics.length > 0 ? `Topics: ${profile.topics.join(", ")}` : null,
    profile.bio ? `About: ${profile.bio}` : null,
    profile.audienceSummary ? `Audience: ${profile.audienceSummary}` : null,
    profile.languages.length > 0 ? `Languages: ${profile.languages.join(", ")}` : null,
    profile.country ? `Country: ${profile.country}` : null,
  ]
  return lines.filter((line): line is string => line !== null).join("\n")
}

/** `embedding_model` value for vectors made now (re-embed when it changes). */
export function currentEmbeddingModel(): string {
  return isFake("embeddings") ? "fake:hashed-bow-1024" : `voyage:${env.VOYAGE_MODEL}`
}

export type EmbeddingOutcome = "updated" | "skipped" | "failed"

/** Re-embed the creator profile. Never throws: a failure is reported and keeps the old vector. */
export async function refreshCreatorEmbedding(
  database: DbOrTx,
  userId: string,
  deps: EmbedDeps = {},
): Promise<EmbeddingOutcome> {
  const profile = await findCreatorProfile(database, userId)
  if (!profile) return "skipped"
  const text = creatorProfileEmbeddingText(profile)
  if (!text.trim()) return "skipped"
  try {
    const [vector] = await embed([text], "document", deps)
    if (!vector) return "failed"
    await database
      .update(creatorProfiles)
      .set({ embedding: vector, embeddingModel: currentEmbeddingModel() })
      .where(eq(creatorProfiles.id, profile.id))
    return "updated"
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error
    reportError(error, { tags: { area: "social", step: "creator_embedding" } })
    return "failed"
  }
}

// --- All of it ---------------------------------------------------------------------------------

export type DerivedRefresh = {
  sizeTier: SizeTier | null
  summary: SummaryOutcome
  embedding: EmbeddingOutcome
}

/**
 * Size tier, then summary, then embedding (which includes the new summary). For callers that did
 * not already recompute the tier inside their own transaction.
 */
export async function refreshCreatorDerived(
  database: DbOrTx,
  userId: string,
  options: { actorUserId?: string | null; ai?: ClaudeDeps; embed?: EmbedDeps } = {},
): Promise<DerivedRefresh> {
  const tier = await withTransaction((tx) => recomputeSizeTier(tx, userId), database)
  const summary = await refreshAudienceSummary(database, userId, {
    actorUserId: options.actorUserId,
    ai: options.ai,
  })
  const embedding = await refreshCreatorEmbedding(database, userId, options.embed)
  return { sizeTier: tier.tier, summary: summary.outcome, embedding }
}

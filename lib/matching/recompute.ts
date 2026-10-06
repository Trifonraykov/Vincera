import "server-only"

import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm"

import { MATCH_EXPLANATION_PROMPT } from "@/lib/ai/prompts/match-explanation"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { matches, savedItems, type MatchFeatures, type TargetType } from "@/lib/db/schema"
import type { MatchWeights } from "@/lib/db/schema/types"
import { track } from "@/lib/events/track"
import type { MatchTrigger } from "@/lib/events/types"

import {
  candidatesFor,
  loadRescoreTarget,
  raiseEfSearch,
  subjectsForTarget,
  type Candidate,
  type RescoreTarget,
} from "./candidates"
import { loadActiveMatchingConfig, type ActiveMatchingConfig } from "./config"
import {
  explanationInput,
  explanationKey,
  type MatchExplanationInput,
  type ViewerRole,
} from "./explanation-text"
import {
  loadBuilderFacts,
  loadCollabHistory,
  loadCreatorFacts,
  type BuilderFactsRow,
  type CreatorFactsRow,
} from "./facts"
import {
  builderTopicSet,
  creatorTopicSet,
  pairEvidence,
  pairFeatures,
  roleForTargetType,
  TARGET_TYPES_FOR_ROLE,
  type CollabHistory,
  type MatchPair,
  type PairEvidence,
} from "./features"
import { scoreFeatures } from "./score"

/**
 * Matching v0 runs (§8, §13; CLAUDE.md §19.24 "Matching", §19.27):
 *
 * - `recomputeMatchesForUser`: rebuild one user's list for each of their app roles (a person
 *   with both roles has a creator list and a builder list): score every candidate, upsert the
 *   top 30 (`ON CONFLICT` on the unique key; score, features, `computed_at`, `stale_at = null`;
 *   never the status), set `stale_at` on the user's other current rows, and emit one
 *   `match.computed`. Rows are never deleted (v1's training data).
 * - `rescoreTarget`: one creator, builder, idea or product changed: re-score it for everyone who
 *   may see it and merge it into their current lists (or stale its rows when it stopped being a
 *   candidate). Merging keeps each list at 30; a list it pushes a row out of loses its lowest
 *   row. The nightly recompute settles anything a merge cannot see (a target that drops out of a
 *   list makes room the next-best candidate only fills then).
 *
 * Both write under a per-subject transaction-level advisory lock, so a recompute and a rescore of
 * one person's list never interleave. Explanations are not written here: rows whose cached
 * sentence no longer fits (or that have none) come back as `pending` and the job generates them
 * after the commit (`explainMatches`, lib/matching/explain.ts), so a slow model never holds a
 * transaction or blocks a page (§7.3).
 */

/** "Show the top 30 per user" (§8), per role. */
export const MATCH_LIST_SIZE = 30
/** Subjects per transaction in a target rescore. */
export const RESCORE_PAGE_SIZE = 200

export type PendingExplanation = {
  matchId: string
  /** The features the sentence will be about; the write is skipped if the row changed since. */
  features: MatchFeatures
  input: MatchExplanationInput
}

export type RoleRecompute = {
  role: ViewerRole
  /** False when the user cannot be matched in this role (no profile, suspended, not onboarded). */
  eligible: boolean
  candidates: number
  stored: number
  staled: number
}

export type RecomputeResult = {
  userId: string
  modelVersion: string
  roles: RoleRecompute[]
  pending: PendingExplanation[]
}

type Scored = {
  targetType: TargetType
  targetId: string
  score: number
  features: MatchFeatures
  evidence: PairEvidence
}

/** Serialise writes to one subject's list (transaction-scoped; released at commit). */
async function lockSubjects(tx: Tx, userIds: readonly string[]): Promise<void> {
  for (const userId of [...new Set(userIds)].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`matches:${userId}`}, 0))`)
  }
}

function compareScored(a: Scored, b: Scored): number {
  return (
    b.score - a.score ||
    a.targetType.localeCompare(b.targetType) ||
    a.targetId.localeCompare(b.targetId)
  )
}

/** Build the pair for a candidate of a creator subject or a builder subject. */
function pairFor(
  subjectRole: ViewerRole,
  subject: CreatorFactsRow | BuilderFactsRow,
  candidate: Candidate,
  creators: ReadonlyMap<string, CreatorFactsRow>,
  builders: ReadonlyMap<string, BuilderFactsRow>,
  history: ReadonlyMap<string, CollabHistory>,
): MatchPair | null {
  const reliability = history.get(candidate.ownerUserId) ?? { completed: 0, disputes: 0 }
  if (subjectRole === "creator") {
    const creator = subject as CreatorFactsRow
    const builder = builders.get(candidate.ownerUserId)
    if (!builder) return null
    if (candidate.targetType === "product") {
      return {
        targetType: "product",
        creator,
        builder,
        product: candidate.product,
        cosine: candidate.cosine,
        reliability,
      }
    }
    if (candidate.targetType === "builder") {
      return { targetType: "builder", creator, builder, cosine: candidate.cosine, reliability }
    }
    return null
  }
  const builder = subject as BuilderFactsRow
  const creator = creators.get(candidate.ownerUserId)
  if (!creator) return null
  if (candidate.targetType === "idea") {
    return {
      targetType: "idea",
      creator,
      builder,
      idea: candidate.idea,
      cosine: candidate.cosine,
      reliability,
    }
  }
  if (candidate.targetType === "creator") {
    return { targetType: "creator", creator, builder, cosine: candidate.cosine, reliability }
  }
  return null
}

function scorePair(pair: MatchPair, weights: MatchWeights, targetId: string): Scored {
  const features = pairFeatures(pair)
  return {
    targetType: pair.targetType,
    targetId,
    score: scoreFeatures(features, weights),
    features,
    evidence: pairEvidence(pair),
  }
}

/** Score every candidate of one role for a subject, best first. */
async function scoreCandidates(
  tx: Tx,
  role: ViewerRole,
  subject: CreatorFactsRow | BuilderFactsRow,
  weights: MatchWeights,
): Promise<Scored[]> {
  const topics = [
    ...(role === "creator"
      ? creatorTopicSet(subject as CreatorFactsRow)
      : builderTopicSet(subject as BuilderFactsRow)),
  ]
  // One query at a time: `tx` is a single connection.
  const candidates: Candidate[] = []
  for (const targetType of TARGET_TYPES_FOR_ROLE[role]) {
    candidates.push(...(await candidatesFor(tx, subject.userId, targetType, topics)))
  }
  const ownerIds = [...new Set(candidates.map((candidate) => candidate.ownerUserId))]
  const creators =
    role === "builder" ? await loadCreatorFacts(tx, ownerIds) : new Map<string, CreatorFactsRow>()
  const builders =
    role === "creator" ? await loadBuilderFacts(tx, ownerIds) : new Map<string, BuilderFactsRow>()
  const history = await loadCollabHistory(tx, ownerIds)
  const scored: Scored[] = []
  for (const candidate of candidates) {
    const pair = pairFor(role, subject, candidate, creators, builders, history)
    if (pair) scored.push(scorePair(pair, weights, candidate.targetId))
  }
  return scored.sort(compareScored)
}

type ExistingRow = {
  id: string
  targetType: TargetType
  targetId: string
  features: MatchFeatures
  explanation: string | null
  explanationPromptVersion: string | null
}

function targetKey(targetType: TargetType, targetId: string): string {
  return `${targetType}:${targetId}`
}

function savedKey(userId: string, targetType: TargetType, targetId: string): string {
  return `${userId}:${targetType}:${targetId}`
}

/** The saved targets of some subjects (`saved_items`), as `savedKey`s. */
async function loadSavedKeys(
  tx: Tx,
  userIds: readonly string[],
  targetTypes: readonly TargetType[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const rows = await tx
    .select({
      userId: savedItems.userId,
      targetType: savedItems.targetType,
      targetId: savedItems.targetId,
    })
    .from(savedItems)
    .where(
      and(
        inArray(savedItems.userId, [...userIds]),
        inArray(savedItems.targetType, [...targetTypes]),
      ),
    )
  return new Set(rows.map((row) => savedKey(row.userId, row.targetType, row.targetId)))
}

/** Keep a cached sentence only while it still describes the leading features (§19.27). */
function keptExplanation(
  existing: ExistingRow | undefined,
  features: MatchFeatures,
  weights: MatchWeights,
): { explanation: string | null; explanationPromptVersion: string | null } {
  if (
    existing?.explanation &&
    existing.explanationPromptVersion === MATCH_EXPLANATION_PROMPT.version &&
    explanationKey(existing.features, weights) === explanationKey(features, weights)
  ) {
    return {
      explanation: existing.explanation,
      explanationPromptVersion: existing.explanationPromptVersion,
    }
  }
  return { explanation: null, explanationPromptVersion: null }
}

/** Upsert scored rows for a subject (status untouched). Returns the rows needing a sentence. */
async function upsertRows(
  tx: Tx,
  subjectUserId: string,
  viewerRole: ViewerRole,
  config: ActiveMatchingConfig,
  rows: readonly Scored[],
  existing: ReadonlyMap<string, ExistingRow>,
  saved: ReadonlySet<string>,
  at: Date,
): Promise<{ ids: string[]; pending: PendingExplanation[] }> {
  if (rows.length === 0) return { ids: [], pending: [] }
  const values = rows.map((row) => ({
    subjectUserId,
    targetType: row.targetType,
    targetId: row.targetId,
    // A new row (e.g. after a model switch) starts saved when the person saved the target; the
    // upsert never changes an existing row's status.
    status: saved.has(savedKey(subjectUserId, row.targetType, row.targetId))
      ? ("saved" as const)
      : ("shown" as const),
    score: row.score,
    features: row.features,
    modelVersion: config.modelVersion,
    computedAt: at,
    staleAt: null,
    ...keptExplanation(
      existing.get(targetKey(row.targetType, row.targetId)),
      row.features,
      config.weights,
    ),
  }))
  const written = await tx
    .insert(matches)
    .values(values)
    .onConflictDoUpdate({
      target: [matches.subjectUserId, matches.targetType, matches.targetId, matches.modelVersion],
      set: {
        score: sql`excluded.score`,
        features: sql`excluded.features`,
        computedAt: sql`excluded.computed_at`,
        staleAt: null,
        explanation: sql`excluded.explanation`,
        explanationPromptVersion: sql`excluded.explanation_prompt_version`,
        updatedAt: at,
      },
    })
    .returning({
      id: matches.id,
      targetType: matches.targetType,
      targetId: matches.targetId,
      explanation: matches.explanation,
    })
  const byKey = new Map(rows.map((row) => [targetKey(row.targetType, row.targetId), row]))
  const pending: PendingExplanation[] = []
  for (const row of written) {
    if (row.explanation) continue
    const scored = byKey.get(targetKey(row.targetType, row.targetId))
    if (!scored) continue
    pending.push({
      matchId: row.id,
      features: scored.features,
      input: explanationInput(
        viewerRole,
        scored.targetType,
        scored.features,
        config.weights,
        scored.evidence,
      ),
    })
  }
  return { ids: written.map((row) => row.id), pending }
}

/** Existing rows of a subject for some target types: the current ones plus any of `targets`. */
async function loadExisting(
  tx: Tx,
  subjectUserIds: readonly string[],
  modelVersion: string,
  targetTypes: readonly TargetType[],
  targetIds: readonly string[],
): Promise<
  (ExistingRow & { subjectUserId: string; score: number; status: string; staleAt: Date | null })[]
> {
  if (subjectUserIds.length === 0) return []
  return tx
    .select({
      id: matches.id,
      subjectUserId: matches.subjectUserId,
      targetType: matches.targetType,
      targetId: matches.targetId,
      score: matches.score,
      status: matches.status,
      staleAt: matches.staleAt,
      features: matches.features,
      explanation: matches.explanation,
      explanationPromptVersion: matches.explanationPromptVersion,
    })
    .from(matches)
    .where(
      and(
        inArray(matches.subjectUserId, [...subjectUserIds]),
        eq(matches.modelVersion, modelVersion),
        inArray(matches.targetType, [...targetTypes]),
        targetIds.length > 0
          ? or(isNull(matches.staleAt), inArray(matches.targetId, [...targetIds]))
          : isNull(matches.staleAt),
      ),
    )
}

function triggerFor(reason: string): MatchTrigger {
  if (reason === "nightly") return "nightly"
  if (reason === "manual") return "manual"
  return "on_change"
}

/**
 * Rebuild `userId`'s match lists (both roles when they have both). Idempotent: the same data gives
 * the same rows. `reason` is the job payload's (`matching/recompute.requested`).
 */
export async function recomputeMatchesForUser(
  database: DbOrTx,
  userId: string,
  options: { reason: string; config?: ActiveMatchingConfig },
): Promise<RecomputeResult> {
  const config = options.config ?? (await loadActiveMatchingConfig(database))
  const started = performance.now()

  return withTransaction(async (tx) => {
    await lockSubjects(tx, [userId])
    await raiseEfSearch(tx)
    const at = now()
    const creators = await loadCreatorFacts(tx, [userId])
    const builders = await loadBuilderFacts(tx, [userId])
    const roles: RoleRecompute[] = []
    const pending: PendingExplanation[] = []
    let candidateCount = 0
    let storedCount = 0
    let topScore: number | null = null

    for (const role of ["creator", "builder"] as const) {
      const subject = role === "creator" ? creators.get(userId) : builders.get(userId)
      const targetTypes = TARGET_TYPES_FOR_ROLE[role]
      if (!subject?.eligible) {
        const staled = await tx
          .update(matches)
          .set({ staleAt: at })
          .where(
            and(
              eq(matches.subjectUserId, userId),
              eq(matches.modelVersion, config.modelVersion),
              inArray(matches.targetType, [...targetTypes]),
              isNull(matches.staleAt),
            ),
          )
          .returning({ id: matches.id })
        if (subject || staled.length > 0) {
          roles.push({ role, eligible: false, candidates: 0, stored: 0, staled: staled.length })
        }
        continue
      }

      const scored = await scoreCandidates(tx, role, subject, config.weights)
      const top = scored.slice(0, MATCH_LIST_SIZE)
      const existing = await loadExisting(
        tx,
        [userId],
        config.modelVersion,
        targetTypes,
        top.map((row) => row.targetId),
      )
      const existingByKey = new Map(
        existing.map((row) => [targetKey(row.targetType, row.targetId), row]),
      )
      const saved = await loadSavedKeys(tx, [userId], targetTypes)
      const written = await upsertRows(tx, userId, role, config, top, existingByKey, saved, at)
      const staled = await tx
        .update(matches)
        .set({ staleAt: at })
        .where(
          and(
            eq(matches.subjectUserId, userId),
            eq(matches.modelVersion, config.modelVersion),
            inArray(matches.targetType, [...targetTypes]),
            isNull(matches.staleAt),
            written.ids.length > 0 ? notInArray(matches.id, written.ids) : undefined,
          ),
        )
        .returning({ id: matches.id })

      pending.push(...written.pending)
      roles.push({
        role,
        eligible: true,
        candidates: scored.length,
        stored: top.length,
        staled: staled.length,
      })
      candidateCount += scored.length
      storedCount += top.length
      const best = top[0]?.score
      if (best !== undefined && (topScore === null || best > topScore)) topScore = best
    }

    if (roles.some((entry) => entry.eligible)) {
      await track(
        "match.computed",
        {
          actorUserId: null,
          subjectType: "user",
          subjectId: userId,
          properties: {
            model_version: config.modelVersion,
            trigger: triggerFor(options.reason),
            candidates: candidateCount,
            stored: storedCount,
            top_score: topScore,
            duration_ms: Math.round(performance.now() - started),
          },
        },
        tx,
      )
    }
    return { userId, modelVersion: config.modelVersion, roles, pending }
  }, database)
}

// --- Target rescore ---------------------------------------------------------------------------

export type RescoreResult = {
  targetType: TargetType
  targetId: string
  /** False when the target is gone or no longer a candidate (its rows were staled). */
  eligible: boolean
  subjects: number
  /** Rows written: upserted plus staled. */
  changed: number
  pending: PendingExplanation[]
}

/** Score one target for a page of subjects of the other role. */
async function scoreTargetForSubjects(
  tx: Tx,
  target: RescoreTarget,
  subjects: readonly { userId: string; cosine: number | null }[],
  weights: MatchWeights,
): Promise<Map<string, Scored>> {
  const subjectRole = roleForTargetType(target.targetType)
  const subjectIds = subjects.map((subject) => subject.userId)
  const creators = await loadCreatorFacts(
    tx,
    subjectRole === "creator" ? subjectIds : [target.ownerUserId],
  )
  const builders = await loadBuilderFacts(
    tx,
    subjectRole === "builder" ? subjectIds : [target.ownerUserId],
  )
  const history = await loadCollabHistory(tx, [target.ownerUserId])
  const scored = new Map<string, Scored>()
  for (const subject of subjects) {
    const subjectFacts =
      subjectRole === "creator" ? creators.get(subject.userId) : builders.get(subject.userId)
    if (!subjectFacts?.eligible) continue
    const candidate: Candidate =
      target.targetType === "product"
        ? {
            targetType: "product",
            targetId: target.targetId,
            ownerUserId: target.ownerUserId,
            cosine: subject.cosine,
            product: target.product,
          }
        : target.targetType === "idea"
          ? {
              targetType: "idea",
              targetId: target.targetId,
              ownerUserId: target.ownerUserId,
              cosine: subject.cosine,
              idea: target.idea,
            }
          : {
              targetType: target.targetType,
              targetId: target.targetId,
              ownerUserId: target.ownerUserId,
              cosine: subject.cosine,
            }
    const pair = pairFor(subjectRole, subjectFacts, candidate, creators, builders, history)
    if (pair) scored.set(subject.userId, scorePair(pair, weights, target.targetId))
  }
  return scored
}

/**
 * Re-score one target for everyone who may see it (job `matching-target-changed`). An idea or
 * product also re-scores its owner as a person, whose facts include their ideas or products.
 */
export async function rescoreTarget(
  database: DbOrTx,
  input: { targetType: TargetType; targetId: string },
  options: { config?: ActiveMatchingConfig; pageSize?: number; includeOwner?: boolean } = {},
): Promise<RescoreResult[]> {
  const config = options.config ?? (await loadActiveMatchingConfig(database))
  const target = await loadRescoreTarget(database, input.targetType, input.targetId)
  const results = [
    await rescoreOne(database, input, target, config, options.pageSize ?? RESCORE_PAGE_SIZE),
  ]
  if (
    target &&
    options.includeOwner !== false &&
    (target.targetType === "idea" || target.targetType === "product")
  ) {
    const ownerType: TargetType = target.targetType === "idea" ? "creator" : "builder"
    const owner = await loadRescoreTarget(database, ownerType, target.ownerUserId)
    results.push(
      await rescoreOne(
        database,
        { targetType: ownerType, targetId: target.ownerUserId },
        owner,
        config,
        options.pageSize ?? RESCORE_PAGE_SIZE,
      ),
    )
  }
  return results
}

async function rescoreOne(
  database: DbOrTx,
  input: { targetType: TargetType; targetId: string },
  target: RescoreTarget | null,
  config: ActiveMatchingConfig,
  pageSize: number,
): Promise<RescoreResult> {
  if (!target || !target.eligible) {
    const staled = await database
      .update(matches)
      .set({ staleAt: now() })
      .where(
        and(
          eq(matches.targetType, input.targetType),
          eq(matches.targetId, input.targetId),
          eq(matches.modelVersion, config.modelVersion),
          isNull(matches.staleAt),
        ),
      )
      .returning({ id: matches.id })
    return { ...input, eligible: false, subjects: 0, changed: staled.length, pending: [] }
  }

  const viewerRole = roleForTargetType(target.targetType)
  const targetTypes = TARGET_TYPES_FOR_ROLE[viewerRole]
  const pending: PendingExplanation[] = []
  let subjects = 0
  let changed = 0
  let afterUserId: string | null = null

  for (;;) {
    const page = await subjectsForTarget(database, target, afterUserId, pageSize)
    if (page.length === 0) break
    subjects += page.length

    const outcome = await withTransaction(async (tx) => {
      await lockSubjects(
        tx,
        page.map((subject) => subject.userId),
      )
      const at = now()
      const scored = await scoreTargetForSubjects(tx, target, page, config.weights)
      const existing = await loadExisting(
        tx,
        [...scored.keys()],
        config.modelVersion,
        targetTypes,
        [target.targetId],
      )
      const saved = await loadSavedKeys(tx, [...scored.keys()], [target.targetType])
      const bySubject = new Map<string, typeof existing>()
      for (const row of existing) {
        const list = bySubject.get(row.subjectUserId)
        if (list) list.push(row)
        else bySubject.set(row.subjectUserId, [row])
      }

      let pageChanged = 0
      const pagePending: PendingExplanation[] = []
      for (const [subjectUserId, entry] of scored) {
        const rows = bySubject.get(subjectUserId) ?? []
        const own = rows.find(
          (row) => row.targetType === target.targetType && row.targetId === target.targetId,
        )
        const others = rows.filter(
          (row) => row !== own && row.staleAt === null && row.status !== "dismissed",
        )
        const merged = [
          ...others.map((row) => ({
            targetType: row.targetType,
            targetId: row.targetId,
            score: row.score,
            id: row.id,
          })),
          { targetType: entry.targetType, targetId: entry.targetId, score: entry.score, id: null },
        ].sort(
          (a, b) =>
            b.score - a.score ||
            a.targetType.localeCompare(b.targetType) ||
            a.targetId.localeCompare(b.targetId),
        )
        const keep = merged.slice(0, MATCH_LIST_SIZE)
        const dropped = merged.slice(MATCH_LIST_SIZE)
        const targetKept = keep.some((row) => row.id === null)

        if (targetKept) {
          const existingByKey = new Map(own ? [[targetKey(own.targetType, own.targetId), own]] : [])
          const written = await upsertRows(
            tx,
            subjectUserId,
            viewerRole,
            config,
            [entry],
            existingByKey,
            saved,
            at,
          )
          pagePending.push(...written.pending)
          pageChanged += written.ids.length
        }
        const staleIds = [
          ...dropped.flatMap((row) => (row.id ? [row.id] : [])),
          ...(!targetKept && own && own.staleAt === null ? [own.id] : []),
        ]
        if (staleIds.length > 0) {
          await tx
            .update(matches)
            .set({ staleAt: at })
            .where(and(inArray(matches.id, staleIds), isNull(matches.staleAt)))
          pageChanged += staleIds.length
        }
      }
      return { changed: pageChanged, pending: pagePending }
    }, database)

    changed += outcome.changed
    pending.push(...outcome.pending)
    const last = page.at(-1)
    if (page.length < pageSize || !last) break
    afterUserId = last.userId
  }

  return { ...input, eligible: true, subjects, changed, pending }
}

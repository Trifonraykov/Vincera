import "server-only"

import { and, eq, isNull, sql } from "drizzle-orm"

import type { ClaudeDeps } from "@/lib/ai/claude"
import { generateMatchExplanation } from "@/lib/ai/prompts/match-explanation"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { matches } from "@/lib/db/schema"
import { track } from "@/lib/events/track"

import type { PendingExplanation } from "./recompute"

/**
 * Write the model's sentence for matches that need one (§7.3 use 3: "Cache it on
 * matches.explanation"), after the recompute committed. Never blocks anything: until a sentence
 * is stored, pages show the deterministic template for the same two features
 * (lib/matching/explanation-text.ts), and a failed generation stores nothing, so the next
 * recompute tries again.
 *
 * Each write is conditional on the row still having no sentence and the same features it was
 * generated for, so a recompute that ran meanwhile is never overwritten with a stale sentence.
 * Every generation emits `ai.generated` (subject `match`, actor null, `accepted_by_user` null).
 */

/** Model calls in flight at once. */
const CONCURRENCY = 4

export type ExplainResult = { generated: number; stored: number; fallbacks: number }

export async function explainMatches(
  database: DbOrTx,
  pending: readonly PendingExplanation[],
  deps: ClaudeDeps = {},
): Promise<ExplainResult> {
  const result: ExplainResult = { generated: 0, stored: 0, fallbacks: 0 }
  let next = 0
  const worker = async () => {
    for (;;) {
      const item = pending[next]
      next += 1
      if (!item) return
      const outcome = await explainOne(database, item, deps)
      result.generated += 1
      if (outcome === "stored") result.stored += 1
      if (outcome === "fallback") result.fallbacks += 1
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
  return result
}

async function explainOne(
  database: DbOrTx,
  item: PendingExplanation,
  deps: ClaudeDeps,
): Promise<"stored" | "skipped" | "fallback"> {
  const result = await generateMatchExplanation(item.input, deps)
  return withTransaction(async (tx) => {
    let outcome: "stored" | "skipped" | "fallback" = "fallback"
    if (result.ok) {
      const updated = await tx
        .update(matches)
        .set({
          explanation: result.data.sentence,
          explanationPromptVersion: result.promptVersion,
          // A derived sentence is not an edit of the match.
          updatedAt: sql`${matches.updatedAt}`,
        })
        .where(
          and(
            eq(matches.id, item.matchId),
            isNull(matches.explanation),
            sql`${matches.features} = ${JSON.stringify(item.features)}::jsonb`,
          ),
        )
        .returning({ id: matches.id })
      outcome = updated.length > 0 ? "stored" : "skipped"
    }
    // The match may have been removed with its user (cascade); there is nothing to record then.
    const [exists] = await tx
      .select({ id: matches.id })
      .from(matches)
      .where(eq(matches.id, item.matchId))
    if (exists) {
      await track(
        "ai.generated",
        {
          actorUserId: null,
          subjectType: "match",
          subjectId: item.matchId,
          properties: {
            use: "match_explanation",
            prompt_version: result.promptVersion,
            model: result.model,
            latency_ms: result.latencyMs,
            accepted_by_user: null,
            fallback: !result.ok,
          },
        },
        tx,
      )
    }
    return outcome
  }, database)
}

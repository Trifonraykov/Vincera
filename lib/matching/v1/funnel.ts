import "server-only"

import { sql } from "drizzle-orm"
import { z } from "zod"

import type { DbOrTx } from "@/lib/db/client"

import { matchOutcomesCte } from "./outcomes"

/**
 * Funnel conversion by match-score bucket (Phase 7 acceptance; CLAUDE.md §19.38): the shown match
 * rows of a model version in five buckets of their stored score, `[0, .2)` … `[.8, 1]`, and how
 * many of them led to a linked proposal, an accepted one, a launch that went live and ≥ 1 sale
 * (definitions in ./outcomes.ts). Each row counts once per step.
 */

export const SCORE_BUCKETS = [
  { index: 0, label: "0–20%", from: 0, to: 0.2 },
  { index: 1, label: "20–40%", from: 0.2, to: 0.4 },
  { index: 2, label: "40–60%", from: 0.4, to: 0.6 },
  { index: 3, label: "60–80%", from: 0.6, to: 0.8 },
  { index: 4, label: "80–100%", from: 0.8, to: 1 },
] as const

export type FunnelBucket = {
  index: number
  label: string
  shown: number
  sent: number
  accepted: number
  live: number
  sale: number
}

export type ScoreFunnel = { modelVersion: string; buckets: FunnelBucket[]; total: FunnelBucket }

const countRow = z.object({
  bucket: z.coerce.number().int(),
  shown: z.coerce.number().int(),
  sent: z.coerce.number().int(),
  accepted: z.coerce.number().int(),
  live: z.coerce.number().int(),
  sale: z.coerce.number().int(),
})

/** The bucket of a score: `[0, .2)`, …, `[.8, 1]` (1 itself falls in the last). */
export function scoreBucketIndex(score: number): number {
  return Math.min(4, Math.max(0, Math.floor(score * 5)))
}

export async function scoreBucketFunnel(
  database: DbOrTx,
  modelVersion: string,
): Promise<ScoreFunnel> {
  const result = await database.execute(sql`
    WITH ${matchOutcomesCte(modelVersion)}
    SELECT
      least(4, greatest(0, floor(score * 5)))::int AS bucket,
      count(*) AS shown,
      count(*) FILTER (WHERE sent) AS sent,
      count(*) FILTER (WHERE accepted) AS accepted,
      count(*) FILTER (WHERE accepted AND live) AS live,
      count(*) FILTER (WHERE accepted AND sale) AS sale
    FROM outcomes
    GROUP BY 1
    ORDER BY 1
  `)
  const byIndex = new Map(
    result.rows.map((raw) => {
      const row = countRow.parse(raw)
      return [row.bucket, row] as const
    }),
  )
  const buckets = SCORE_BUCKETS.map((bucket) => {
    const row = byIndex.get(bucket.index)
    return {
      index: bucket.index,
      label: bucket.label,
      shown: row?.shown ?? 0,
      sent: row?.sent ?? 0,
      accepted: row?.accepted ?? 0,
      live: row?.live ?? 0,
      sale: row?.sale ?? 0,
    }
  })
  const total = buckets.reduce(
    (sum, bucket) => ({
      ...sum,
      shown: sum.shown + bucket.shown,
      sent: sum.sent + bucket.sent,
      accepted: sum.accepted + bucket.accepted,
      live: sum.live + bucket.live,
      sale: sum.sale + bucket.sale,
    }),
    { index: -1, label: "All", shown: 0, sent: 0, accepted: 0, live: 0, sale: 0 },
  )
  return { modelVersion, buckets, total }
}

/** A step's rate against the step before it; null when the previous step is 0 (pure). */
export function stepRate(count: number, previous: number): number | null {
  return previous > 0 ? count / previous : null
}

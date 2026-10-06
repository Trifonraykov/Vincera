import type { ProductFormat } from "@/lib/db/schema/enums"

/**
 * Did the creator keep the AI brief? (§7.3.2, §11 `ai.reviewed` for `idea_brief`; rule decided
 * in CLAUDE.md §19.25.) Pure and client-safe, so it is unit-tested on its own.
 *
 * - `edited`: anything the creator saved differs from the draft: title, problem or evidence
 *   (whitespace aside), format, price or the set of topics.
 * - `accepted` ("saved largely unchanged"): the saved title, problem and audience evidence keep at
 *   least 80% of the draft's words: the Dice coefficient of the two word multisets (lowercase
 *   letters and digits) is ≥ 0.8. Format, price and topic changes alone never make a brief
 *   "rejected": they are choices the draft only suggests.
 */

export const BRIEF_ACCEPTANCE_THRESHOLD = 0.8

export type BriefFields = {
  title: string
  problem: string | null
  audienceEvidence: string | null
  format: ProductFormat | null
  targetPriceCents: number | null
  topics: readonly string[]
}

export type BriefReview = {
  accepted: boolean
  edited: boolean
  /** Word similarity of the text fields, 0–1. */
  similarity: number
}

function squash(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return counts
}

/** Dice coefficient over word multisets: 2·|A ∩ B| / (|A| + |B|); two empty texts → 1. */
export function wordSimilarity(a: string, b: string): number {
  const left = wordCounts(a)
  const right = wordCounts(b)
  let sizeA = 0
  let sizeB = 0
  let shared = 0
  for (const count of left.values()) sizeA += count
  for (const [word, count] of right) {
    sizeB += count
    shared += Math.min(count, left.get(word) ?? 0)
  }
  if (sizeA + sizeB === 0) return 1
  return (2 * shared) / (sizeA + sizeB)
}

function textOf(fields: BriefFields): string {
  return [fields.title, fields.problem, fields.audienceEvidence].map(squash).join("\n")
}

function sameTopics(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((topic) => right.has(topic))
}

export function reviewBrief(generated: BriefFields, saved: BriefFields): BriefReview {
  const similarity = wordSimilarity(textOf(generated), textOf(saved))
  const edited =
    squash(generated.title) !== squash(saved.title) ||
    squash(generated.problem) !== squash(saved.problem) ||
    squash(generated.audienceEvidence) !== squash(saved.audienceEvidence) ||
    generated.format !== saved.format ||
    generated.targetPriceCents !== saved.targetPriceCents ||
    !sameTopics(generated.topics, saved.topics)
  return {
    accepted: similarity >= BRIEF_ACCEPTANCE_THRESHOLD,
    edited,
    similarity: Math.round(similarity * 1000) / 1000,
  }
}

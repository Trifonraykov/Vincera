import { describe, expect, it } from "vitest"

import {
  BRIEF_ACCEPTANCE_THRESHOLD,
  reviewBrief,
  wordSimilarity,
  type BriefFields,
} from "@/lib/ideas/brief-review"

/** "Saved the AI brief largely unchanged" (§7.3.2 `ai.reviewed`; rule in CLAUDE.md §19.25). */

const DRAFT: BriefFields = {
  title: "Budget planner for students",
  problem:
    "Students run out of money before the month ends. They want a simple planner that shows what is left each week.",
  audienceEvidence: "12 of 30 comments ask for a budget template. “Where does my money go?”",
  format: "template",
  targetPriceCents: 1900,
  topics: ["budgeting", "students"],
}

describe("wordSimilarity", () => {
  it("is 1 for the same words, 0 for none in common, and ignores case and punctuation", () => {
    expect(wordSimilarity("A b, c!", "a B c")).toBe(1)
    expect(wordSimilarity("one two", "three four")).toBe(0)
    expect(wordSimilarity("", "")).toBe(1)
    expect(wordSimilarity("a a b", "a b")).toBeCloseTo(0.8)
  })
})

describe("reviewBrief", () => {
  it("counts an untouched brief as accepted and not edited", () => {
    expect(reviewBrief(DRAFT, { ...DRAFT })).toEqual({
      accepted: true,
      edited: false,
      similarity: 1,
    })
  })

  it("ignores whitespace-only differences", () => {
    const saved = { ...DRAFT, problem: `  ${DRAFT.problem?.replace(/ /g, "  ")}\n` }
    expect(reviewBrief(DRAFT, saved)).toMatchObject({ accepted: true, edited: false })
  })

  it("keeps a lightly edited brief accepted, but edited", () => {
    const saved = { ...DRAFT, title: "Weekly budget planner for students" }
    const review = reviewBrief(DRAFT, saved)
    expect(review.accepted).toBe(true)
    expect(review.edited).toBe(true)
    expect(review.similarity).toBeGreaterThanOrEqual(BRIEF_ACCEPTANCE_THRESHOLD)
  })

  it("does not count format, price or topic changes against acceptance", () => {
    const saved = { ...DRAFT, format: "app" as const, targetPriceCents: 900, topics: ["money"] }
    expect(reviewBrief(DRAFT, saved)).toMatchObject({ accepted: true, edited: true })
  })

  it("counts a rewrite as not accepted", () => {
    const saved: BriefFields = {
      ...DRAFT,
      title: "Meal prep calendar",
      problem: "Busy parents need dinners planned for the week with a shopping list.",
      audienceEvidence: null,
    }
    const review = reviewBrief(DRAFT, saved)
    expect(review.accepted).toBe(false)
    expect(review.edited).toBe(true)
    expect(review.similarity).toBeLessThan(BRIEF_ACCEPTANCE_THRESHOLD)
  })
})

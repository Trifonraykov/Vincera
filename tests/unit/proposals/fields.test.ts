import { describe, expect, it } from "vitest"

import {
  complementPct,
  PROPOSAL_MESSAGE_MAX,
  proposalTermsSchema,
  SPLIT_SUM_MESSAGE,
  validateSplit,
} from "@/lib/proposals/fields"
import {
  formatRelative,
  formatTimeLeft,
  parseProposalTab,
  revisionChanges,
} from "@/lib/proposals/display"

/** Proposal terms: split validation, the form schema, and what the pages say about them. */

const form = {
  message: "",
  scope: "A web app",
  creatorSplitPct: "60",
  builderSplitPct: "40",
  timelineWeeks: "6",
}

function fieldErrors(input: Record<string, unknown>) {
  const result = proposalTermsSchema.safeParse(input)
  if (result.success) return null
  const errors: Record<string, string> = {}
  for (const issue of result.error.issues) errors[issue.path.join(".")] ??= issue.message
  return errors
}

describe("split validation", () => {
  it("accepts whole shares from 0 to 100 that add up to 100", () => {
    for (const [creator, builder] of [
      [0, 100],
      [100, 0],
      [60, 40],
      [33, 67],
    ] as const) {
      expect(validateSplit(creator, builder)).toBeNull()
    }
  })

  it("refuses sums other than 100, fractions and out-of-range shares", () => {
    expect(validateSplit(60, 50)).toBe(SPLIT_SUM_MESSAGE)
    expect(validateSplit(50, 49)).toBe(SPLIT_SUM_MESSAGE)
    expect(validateSplit(50.5, 49.5)).toMatch(/whole number/)
    expect(validateSplit(-10, 110)).toMatch(/between 0% and 100%/)
    expect(validateSplit(110, -10)).toMatch(/between 0% and 100%/)
    expect(validateSplit(Number.NaN, 100)).toMatch(/whole number/)
  })

  it("computes the other side of the linked slider", () => {
    expect(complementPct(60)).toBe(40)
    expect(complementPct(0)).toBe(100)
    expect(complementPct(140)).toBe(0)
    expect(complementPct(-5)).toBe(100)
    expect(complementPct(33.4)).toBe(67)
  })
})

describe("proposalTermsSchema", () => {
  it("parses what the form submits", () => {
    expect(proposalTermsSchema.parse({ ...form, creatorSplitPct: " 60% " })).toEqual({
      message: null,
      scope: "A web app",
      creatorSplitPct: 60,
      builderSplitPct: 40,
      timelineWeeks: 6,
    })
  })

  it("puts the sum error on the split, and other errors on their fields", () => {
    expect(fieldErrors({ ...form, builderSplitPct: "50" })).toEqual({
      creatorSplitPct: SPLIT_SUM_MESSAGE,
    })
    expect(fieldErrors({ ...form, creatorSplitPct: "60.5", builderSplitPct: "39.5" })).toEqual({
      creatorSplitPct: "Enter the creator's share as a whole number.",
      builderSplitPct: "Enter the builder's share as a whole number.",
    })
    expect(fieldErrors({ ...form, creatorSplitPct: "", builderSplitPct: "abc" })).toMatchObject({
      creatorSplitPct: expect.stringMatching(/whole number/),
      builderSplitPct: expect.stringMatching(/whole number/),
    })
    expect(fieldErrors({ ...form, creatorSplitPct: "120", builderSplitPct: "-20" })).toEqual({
      creatorSplitPct: "The creator's share must be between 0% and 100%.",
      builderSplitPct: "The builder's share must be between 0% and 100%.",
    })
    expect(fieldErrors({ ...form, scope: "   " })).toEqual({
      scope: "Describe what you'll build together.",
    })
    expect(fieldErrors({ ...form, timelineWeeks: "0" })).toMatchObject({
      timelineWeeks: expect.stringMatching(/at least 1 week/),
    })
    expect(fieldErrors({ ...form, timelineWeeks: "53" })).toMatchObject({
      timelineWeeks: expect.stringMatching(/under 53 weeks/),
    })
  })

  it("counts text as stored: CRLF line breaks are one character", () => {
    const message = `${"a\r\n".repeat(PROPOSAL_MESSAGE_MAX / 2)}`
    const parsed = proposalTermsSchema.parse({ ...form, message })
    expect(parsed.message?.includes("\r")).toBe(false)
    expect(fieldErrors({ ...form, message: "a".repeat(PROPOSAL_MESSAGE_MAX + 1) })).toMatchObject({
      message: expect.stringMatching(/under 2,000 characters/),
    })
  })
})

describe("proposal display helpers", () => {
  const base = {
    scope: "A web app",
    message: null,
    creatorSplitPct: 60,
    builderSplitPct: 40,
    timelineWeeks: 6,
  }

  it("lists what a counter-offer changed (never the note)", () => {
    expect(revisionChanges(null, base)).toEqual([])
    expect(revisionChanges(base, { ...base, message: "new note" })).toEqual([])
    expect(
      revisionChanges(base, {
        ...base,
        creatorSplitPct: 70,
        builderSplitPct: 30,
        timelineWeeks: 8,
        scope: "A web app and a mobile app",
      }),
    ).toEqual(["split", "timelineWeeks", "scope"])
    expect(revisionChanges(base, { ...base, scope: " A web app " })).toEqual([])
  })

  it("says how long is left and how long ago", () => {
    const now = new Date("2026-10-05T12:00:00Z")
    const later = (ms: number) => new Date(now.getTime() + ms)
    expect(formatTimeLeft(later(-1), now)).toBe("now")
    expect(formatTimeLeft(later(30 * 60_000), now)).toBe("in less than an hour")
    expect(formatTimeLeft(later(3_600_000), now)).toBe("in 1 hour")
    expect(formatTimeLeft(later(14 * 86_400_000), now)).toBe("in 14 days")
    expect(formatRelative(later(-20_000), now)).toBe("just now")
    expect(formatRelative(later(-5 * 60_000), now)).toBe("5 min ago")
    expect(formatRelative(later(-3 * 3_600_000), now)).toBe("3 h ago")
    expect(formatRelative(later(-30 * 3_600_000), now)).toBe("yesterday")
    expect(formatRelative(new Date("2026-08-01T00:00:00Z"), now)).toBe("1 Aug")
    expect(formatRelative(new Date("2025-08-01T00:00:00Z"), now)).toBe("1 Aug 2025")
  })

  it("reads the list tab from the query string", () => {
    expect(parseProposalTab("sent")).toBe("sent")
    expect(parseProposalTab("closed")).toBe("closed")
    expect(parseProposalTab(undefined)).toBe("received")
    expect(parseProposalTab(["sent"])).toBe("received")
    expect(parseProposalTab("nope")).toBe("received")
  })
})

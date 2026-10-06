import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { allocateLargestRemainder } from "@/lib/ledger/allocate"
import { LedgerError } from "@/lib/ledger/errors"
import { computeSplit, takeRateBps } from "@/lib/ledger/split"
import type { SplitMember } from "@/lib/ledger/types"

/** The §9 split: worked examples, edge cases, and property tests (≥ 1000 runs each). */

const RUNS = { numRuns: 1000 }
const A = "0190a000-0000-7000-8000-00000000000a"
const B = "0190a000-0000-7000-8000-00000000000b"
const C = "0190a000-0000-7000-8000-00000000000c"

const creator = (userId: string, splitPct: number): SplitMember => ({
  userId,
  role: "creator",
  splitPct,
})
const builder = (userId: string, splitPct: number): SplitMember => ({
  userId,
  role: "builder",
  splitPct,
})

const sum = (values: readonly { amountCents: number }[]) =>
  values.reduce((total, value) => total + value.amountCents, 0)

describe("computeSplit: worked examples", () => {
  it("splits a €19 sale with 21% VAT, the fake card fee and a 10% take, 60/40", () => {
    const result = computeSplit({
      grossCents: 1900,
      taxCents: 330,
      stripeFeeCents: 54,
      takeRateBps: 1000,
      members: [creator(A, 60), builder(B, 40)],
    })
    expect(result.netCents).toBe(1516)
    expect(result.platformFeeCents).toBe(152) // 151.6 → 152
    expect(result.distributableCents).toBe(1364)
    // 818.4 and 545.6: the leftover cent goes to the larger remainder (the builder).
    expect(result.shares).toEqual([
      { userId: A, role: "creator", amountCents: 818 },
      { userId: B, role: "builder", amountCents: 546 },
    ])
    expect(result.lines).toEqual([
      { account: "tax", userId: null, amountCents: 330 },
      { account: "stripe_fee", userId: null, amountCents: 54 },
      { account: "platform_fee", userId: null, amountCents: 152 },
      { account: "creator_share", userId: A, amountCents: 818 },
      { account: "builder_share", userId: B, amountCents: 546 },
    ])
    expect(sum(result.lines)).toBe(1900)
  })

  it("rounds the platform fee half up", () => {
    // net 1005 × 10% = 100.5 → 101
    const result = computeSplit({
      grossCents: 1005,
      taxCents: 0,
      stripeFeeCents: 0,
      takeRateBps: 1000,
      members: [creator(A, 100)],
    })
    expect(result.platformFeeCents).toBe(101)
    expect(result.shares[0]?.amountCents).toBe(904)
  })

  it("breaks equal remainders in favour of the lower user id, whatever the input order", () => {
    const input = (members: SplitMember[]) =>
      computeSplit({ grossCents: 1001, taxCents: 0, stripeFeeCents: 0, takeRateBps: 0, members })
    const forward = input([creator(A, 50), builder(B, 50)])
    const backward = input([builder(B, 50), creator(A, 50)])
    expect(forward.shares.map((s) => [s.userId, s.amountCents])).toEqual([
      [A, 501],
      [B, 500],
    ])
    expect(backward).toEqual(forward)
  })

  it("handles three members with an uneven split", () => {
    const result = computeSplit({
      grossCents: 100,
      taxCents: 0,
      stripeFeeCents: 0,
      takeRateBps: 0,
      members: [creator(C, 34), builder(B, 33), creator(A, 33)],
    })
    // 34 / 33 / 33 exactly.
    expect(result.shares.map((s) => s.amountCents)).toEqual([33, 33, 34])
    expect(sum(result.lines)).toBe(100)
  })

  it("gives a 100/0 split all to one member and drops the zero line", () => {
    const result = computeSplit({
      grossCents: 2900,
      taxCents: 503,
      stripeFeeCents: 69,
      takeRateBps: 1000,
      members: [creator(A, 100), builder(B, 0)],
    })
    expect(result.shares.find((s) => s.userId === B)?.amountCents).toBe(0)
    expect(result.lines.some((line) => line.userId === B)).toBe(false)
    expect(sum(result.lines)).toBe(2900)
  })

  it("handles a zero fee, zero tax and a zero take rate", () => {
    const result = computeSplit({
      grossCents: 1000,
      taxCents: 0,
      stripeFeeCents: 0,
      takeRateBps: 0,
      members: [creator(A, 70), builder(B, 30)],
    })
    expect(result.lines).toEqual([
      { account: "creator_share", userId: A, amountCents: 700 },
      { account: "builder_share", userId: B, amountCents: 300 },
    ])
  })

  it("writes nothing for a free order", () => {
    const result = computeSplit({
      grossCents: 0,
      taxCents: 0,
      stripeFeeCents: 0,
      takeRateBps: 1000,
      members: [creator(A, 60), builder(B, 40)],
    })
    expect(result.lines).toEqual([])
    expect(result.distributableCents).toBe(0)
  })

  it("puts a loss (tax + fee > gross) on the platform and gives members nothing", () => {
    const result = computeSplit({
      grossCents: 50,
      taxCents: 9,
      stripeFeeCents: 60,
      takeRateBps: 1000,
      members: [creator(A, 60), builder(B, 40)],
    })
    expect(result.netCents).toBe(-19)
    expect(result.platformFeeCents).toBe(-19)
    expect(result.distributableCents).toBe(0)
    expect(result.shares.every((s) => s.amountCents === 0)).toBe(true)
    expect(result.lines).toEqual([
      { account: "tax", userId: null, amountCents: 9 },
      { account: "stripe_fee", userId: null, amountCents: 60 },
      { account: "platform_fee", userId: null, amountCents: -19 },
    ])
  })

  it("takes everything at a 100% take rate", () => {
    const result = computeSplit({
      grossCents: 999,
      taxCents: 0,
      stripeFeeCents: 40,
      takeRateBps: 10_000,
      members: [creator(A, 50), builder(B, 50)],
    })
    expect(result.platformFeeCents).toBe(959)
    expect(result.distributableCents).toBe(0)
  })
})

describe("computeSplit: refused inputs", () => {
  const base = {
    grossCents: 1000,
    taxCents: 0,
    stripeFeeCents: 0,
    takeRateBps: 1000,
    members: [creator(A, 60), builder(B, 40)],
  }
  it.each([
    ["a float gross", { grossCents: 10.5 }],
    ["a negative tax", { taxCents: -1 }],
    ["a negative fee", { stripeFeeCents: -1 }],
    ["a take rate above 100%", { takeRateBps: 10_001 }],
    ["a float take rate", { takeRateBps: 10.5 }],
    ["no members", { members: [] }],
    ["splits that do not sum to 100", { members: [creator(A, 60), builder(B, 30)] }],
    ["a duplicate member", { members: [creator(A, 50), builder(A, 50)] }],
    ["a fractional split", { members: [creator(A, 60.5), builder(B, 39.5)] }],
    ["a negative split", { members: [creator(A, 110), builder(B, -10)] }],
  ])("refuses %s", (_label, override) => {
    expect(() => computeSplit({ ...base, ...override })).toThrow(LedgerError)
  })
})

describe("takeRateBps", () => {
  it("converts the env rate to basis points", () => {
    expect(takeRateBps(0.1)).toBe(1000)
    expect(takeRateBps(0.125)).toBe(1250)
    expect(takeRateBps(0)).toBe(0)
    expect(takeRateBps(1)).toBe(10_000)
    expect(() => takeRateBps(1.5)).toThrow(RangeError)
    expect(() => takeRateBps(Number.NaN)).toThrow(RangeError)
  })
})

// --- Properties ------------------------------------------------------------------------------

/** 1–6 members with distinct sortable ids and integer splits summing to 100. */
const membersArb = fc.integer({ min: 1, max: 6 }).chain((count) =>
  fc
    .tuple(
      fc.uniqueArray(fc.uuid(), { minLength: count, maxLength: count }),
      fc.array(fc.integer({ min: 0, max: 100 }), { minLength: count - 1, maxLength: count - 1 }),
      fc.array(fc.boolean(), { minLength: count, maxLength: count }),
    )
    .map(([ids, cuts, roles]) => {
      const points = [0, ...[...cuts].sort((a, b) => a - b), 100]
      return ids.map((userId, index) => ({
        userId,
        role: roles[index] ? ("creator" as const) : ("builder" as const),
        splitPct: (points[index + 1] ?? 100) - (points[index] ?? 0),
      }))
    }),
)

const splitInputArb = fc
  .record({
    grossCents: fc.integer({ min: 0, max: 100_000_000 }),
    taxShare: fc.double({ min: 0, max: 0.4, noNaN: true }),
    feeCents: fc.integer({ min: 0, max: 5_000 }),
    takeRateBps: fc.integer({ min: 0, max: 10_000 }),
    members: membersArb,
  })
  .map(({ grossCents, taxShare, feeCents, takeRateBps: bps, members }) => ({
    grossCents,
    taxCents: Math.floor(grossCents * taxShare),
    stripeFeeCents: feeCents,
    takeRateBps: bps,
    members,
  }))

describe("computeSplit: properties", () => {
  it("lines are integers and always sum to gross", () => {
    fc.assert(
      fc.property(splitInputArb, (input) => {
        const result = computeSplit(input)
        for (const line of result.lines) expect(Number.isSafeInteger(line.amountCents)).toBe(true)
        expect(sum(result.lines)).toBe(input.grossCents)
        expect(result.netCents).toBe(input.grossCents - input.taxCents - input.stripeFeeCents)
        expect(result.platformFeeCents + result.distributableCents).toBe(result.netCents)
        expect(sum(result.shares)).toBe(result.distributableCents)
        expect(result.lines.every((line) => line.amountCents !== 0)).toBe(true)
      }),
      RUNS,
    )
  })

  it("each share is within one cent of its exact proportion", () => {
    fc.assert(
      fc.property(splitInputArb, (input) => {
        const result = computeSplit(input)
        for (const share of result.shares) {
          const pct = input.members.find((m) => m.userId === share.userId)?.splitPct ?? -1
          // |share − distributable × pct / 100| < 1, in integers.
          expect(Math.abs(share.amountCents * 100 - result.distributableCents * pct)).toBeLessThan(
            100,
          )
        }
      }),
      RUNS,
    )
  })

  it("the platform fee is net × rate rounded half up, and never negative when net ≥ 0", () => {
    fc.assert(
      fc.property(splitInputArb, (input) => {
        const result = computeSplit(input)
        if (result.netCents <= 0) {
          expect(result.platformFeeCents).toBe(result.netCents)
          expect(result.distributableCents).toBe(0)
          return
        }
        const exact = result.netCents * input.takeRateBps
        const diff = result.platformFeeCents * 10_000 - exact
        expect(diff).toBeGreaterThan(-5_000) // never rounded down past .5
        expect(diff).toBeLessThanOrEqual(5_000) // .5 rounds up
        expect(result.platformFeeCents).toBeGreaterThanOrEqual(0)
        expect(result.platformFeeCents).toBeLessThanOrEqual(result.netCents)
      }),
      RUNS,
    )
  })

  it("never gives a member a negative share", () => {
    fc.assert(
      fc.property(splitInputArb, (input) => {
        const result = computeSplit(input)
        for (const share of result.shares) expect(share.amountCents).toBeGreaterThanOrEqual(0)
        for (const share of result.shares) {
          const pct = input.members.find((m) => m.userId === share.userId)?.splitPct
          if (pct === 0) expect(share.amountCents).toBe(0)
        }
      }),
      RUNS,
    )
  })

  it("is deterministic and independent of the members' order", () => {
    fc.assert(
      fc.property(splitInputArb, fc.array(fc.nat(), { maxLength: 6 }), (input, swaps) => {
        const shuffled = [...input.members]
        swaps.forEach((swap, index) => {
          const j = swap % shuffled.length
          const i = index % shuffled.length
          const left = shuffled[i]
          const right = shuffled[j]
          if (left && right) {
            shuffled[i] = right
            shuffled[j] = left
          }
        })
        expect(computeSplit({ ...input, members: shuffled })).toEqual(computeSplit(input))
      }),
      RUNS,
    )
  })

  it("when tax + fee exceed gross, the platform line carries the whole loss", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        membersArb,
        (gross, excess, members) => {
          const tax = Math.floor(gross / 2)
          const fee = gross - tax + excess
          const result = computeSplit({
            grossCents: gross,
            taxCents: tax,
            stripeFeeCents: fee,
            takeRateBps: 1000,
            members,
          })
          expect(result.platformFeeCents).toBe(-excess)
          expect(result.shares.every((s) => s.amountCents === 0)).toBe(true)
          expect(sum(result.lines)).toBe(gross)
        },
      ),
      RUNS,
    )
  })
})

describe("allocateLargestRemainder", () => {
  it("handles negative weights and refuses mismatched totals", () => {
    expect(allocateLargestRemainder(10, [15, -5], 10)).toEqual([15, -5])
    expect(allocateLargestRemainder(5, [15, -5], 10)).toEqual([8, -3])
    expect(() => allocateLargestRemainder(5, [1, 2], 10)).toThrow(LedgerError)
    expect(() => allocateLargestRemainder(5, [5, 5], 0)).toThrow(LedgerError)
  })

  it("parts sum to the total and stay within a cent of exact (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000, max: 100_000 }), { minLength: 1, maxLength: 8 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (weights, share) => {
          const denominator = weights.reduce((a, b) => a + b, 0)
          fc.pre(denominator > 0)
          const total = Math.floor(denominator * share)
          const parts = allocateLargestRemainder(total, weights, denominator)
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
          parts.forEach((part, index) => {
            const weight = weights[index] ?? 0
            expect(Math.abs(part * denominator - total * weight)).toBeLessThan(denominator)
            // Never past the weight, never the wrong sign.
            if (weight >= 0) {
              expect(part).toBeGreaterThanOrEqual(0)
              expect(part).toBeLessThanOrEqual(weight)
            } else {
              expect(part).toBeLessThanOrEqual(0)
              expect(part).toBeGreaterThanOrEqual(weight)
            }
          })
        },
      ),
      RUNS,
    )
  })
})

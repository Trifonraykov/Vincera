import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { LedgerError } from "@/lib/ledger/errors"
import {
  componentsFromEntries,
  computeChargebackMirror,
  disputeFeeLines,
  computeRefundMirror,
  type MirrorAccount,
  type SaleComponent,
  type StoredOrderLine,
} from "@/lib/ledger/refund"
import { computeSplit } from "@/lib/ledger/split"
import type { LedgerLine, SplitInput } from "@/lib/ledger/types"

/** Refund and chargeback mirrors (§9, §19.10): worked examples and property tests. */

const RUNS = { numRuns: 1000 }
const A = "0190a000-0000-7000-8000-00000000000a"
const B = "0190a000-0000-7000-8000-00000000000b"

const sum = (lines: readonly { amountCents: number }[]) =>
  lines.reduce((total, line) => total + line.amountCents, 0)

function componentsOf(lines: readonly LedgerLine[]): SaleComponent[] {
  return lines.map((line) => ({
    account: line.account as MirrorAccount,
    userId: line.userId,
    saleCents: line.amountCents,
    reversedCents: 0,
  }))
}

/** The €19 example of split.test.ts: tax 330, fee 54, platform 152, creator 818, builder 546. */
const SALE = computeSplit({
  grossCents: 1900,
  taxCents: 330,
  stripeFeeCents: 54,
  takeRateBps: 1000,
  members: [
    { userId: A, role: "creator", splitPct: 60 },
    { userId: B, role: "builder", splitPct: 40 },
  ],
})

describe("computeRefundMirror: worked examples", () => {
  it("a full refund zeroes every component; the Stripe fee becomes a platform adjustment", () => {
    const mirror = computeRefundMirror({ components: componentsOf(SALE.lines), amountCents: 1900 })
    expect(mirror.lines).toEqual([
      { account: "tax", userId: null, amountCents: -330 },
      { account: "adjustment", userId: null, amountCents: -54 },
      { account: "platform_fee", userId: null, amountCents: -152 },
      { account: "creator_share", userId: A, amountCents: -818 },
      { account: "builder_share", userId: B, amountCents: -546 },
    ])
    expect(sum([...SALE.lines, ...mirror.lines])).toBe(0)
    expect(mirror.lines.some((line) => line.account === "stripe_fee")).toBe(false)
  })

  it("a half refund is proportional, sums to −amount, and the rest refunds exactly", () => {
    const components = componentsOf(SALE.lines)
    const half = computeRefundMirror({ components, amountCents: 950 })
    expect(sum(half.lines)).toBe(-950)
    expect(half.allocations.map((a) => a.reversedCents)).toEqual([165, 27, 76, 409, 273])

    const after = components.map((c) => ({
      ...c,
      reversedCents:
        half.allocations.find((a) => a.account === c.account && a.userId === c.userId)
          ?.reversedCents ?? 0,
    }))
    const rest = computeRefundMirror({ components: after, amountCents: 950 })
    expect(sum(rest.lines)).toBe(-950)
    // Both halves together reverse each component exactly.
    for (const component of after) {
      const second =
        rest.allocations.find(
          (a) => a.account === component.account && a.userId === component.userId,
        )?.reversedCents ?? 0
      expect(component.reversedCents + second).toBe(component.saleCents)
    }
  })

  it("refuses a refund larger than what is left, and non-positive amounts", () => {
    const components = componentsOf(SALE.lines)
    expect(() => computeRefundMirror({ components, amountCents: 1901 })).toThrow(
      expect.objectContaining({ code: "over_refund" }),
    )
    expect(() => computeRefundMirror({ components, amountCents: 0 })).toThrow(LedgerError)
    expect(() => computeRefundMirror({ components, amountCents: 1.5 })).toThrow(LedgerError)
    expect(() => computeRefundMirror({ components: [], amountCents: 1 })).toThrow(LedgerError)
  })

  it("refuses components already reversed past their sale amount", () => {
    const components = componentsOf(SALE.lines).map((c, index) =>
      index === 0 ? { ...c, reversedCents: c.saleCents + 1 } : c,
    )
    expect(() => computeRefundMirror({ components, amountCents: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_state" }),
    )
  })

  it("breaks equal remainders toward platform lines first", () => {
    // 1 cent over two equal components: the platform fee gets it, not the member.
    const mirror = computeRefundMirror({
      components: [
        { account: "creator_share", userId: A, saleCents: 50, reversedCents: 0 },
        { account: "platform_fee", userId: null, saleCents: 50, reversedCents: 0 },
      ],
      amountCents: 1,
    })
    expect(mirror.lines).toEqual([{ account: "platform_fee", userId: null, amountCents: -1 }])
  })
})

describe("computeChargebackMirror", () => {
  it("mirrors the disputed amount; the dispute fee is a separate platform pair", () => {
    const mirror = computeChargebackMirror({
      components: componentsOf(SALE.lines),
      amountCents: 1900,
    })
    expect(sum(mirror.lines)).toBe(-1900)
    expect(mirror).toMatchObject({ mirroredCents: 1900, excessCents: 0 })
    expect(mirror.lines.some((line) => line.account === "stripe_fee")).toBe(false)
    expect(disputeFeeLines(1500)).toEqual([
      { account: "stripe_fee", userId: null, amountCents: 1500 },
      { account: "adjustment", userId: null, amountCents: -1500 },
    ])
    expect(disputeFeeLines(-1500)).toEqual([
      { account: "stripe_fee", userId: null, amountCents: -1500 },
      { account: "adjustment", userId: null, amountCents: 1500 },
    ])
    expect(disputeFeeLines(0)).toEqual([])
  })

  it("caps the mirror at what is left after a refund and books the excess on the platform", () => {
    const refund = computeRefundMirror({ components: componentsOf(SALE.lines), amountCents: 1000 })
    const stored: StoredOrderLine[] = [
      ...SALE.lines.map((line) => ({ ...line, refundId: null, chargebackId: null })),
      ...refund.lines.map((line) => ({ ...line, refundId: "re", chargebackId: null })),
    ]
    const chargeback = computeChargebackMirror({
      components: componentsFromEntries(stored),
      amountCents: 1900,
    })
    expect(chargeback).toMatchObject({ mirroredCents: 900, excessCents: 1000 })
    expect(sum(chargeback.lines)).toBe(-1900)
    expect(chargeback.lines.at(-1)).toEqual({
      account: "adjustment",
      userId: null,
      amountCents: -1000,
    })
    const all = [
      ...stored,
      ...chargeback.lines.map((line) => ({ ...line, refundId: null, chargebackId: "cb" })),
    ]
    // Every member and platform component is fully reversed; only the excess remains.
    for (const component of componentsFromEntries(all)) {
      expect(component.saleCents - component.reversedCents).toBe(0)
    }
    expect(sum(all)).toBe(-1000)
    // A chargeback after a full refund mirrors nothing: all of it is the platform's loss.
    const afterFull = computeChargebackMirror({
      components: componentsFromEntries(all),
      amountCents: 500,
    })
    expect(afterFull.lines).toEqual([{ account: "adjustment", userId: null, amountCents: -500 }])
  })

  it("rebuilds components from stored lines with the fee pair cancelling out", () => {
    const chargeback = computeChargebackMirror({
      components: componentsOf(SALE.lines),
      amountCents: 1000,
    })
    const stored: StoredOrderLine[] = [
      ...SALE.lines.map((line) => ({ ...line, refundId: null, chargebackId: null })),
      ...[...chargeback.lines, ...disputeFeeLines(1500)].map((line) => ({
        ...line,
        refundId: null,
        chargebackId: "cb",
      })),
    ]
    const components = componentsFromEntries(stored)
    expect(components.reduce((t, c) => t + c.saleCents - c.reversedCents, 0)).toBe(900)
    const rest = computeRefundMirror({ components, amountCents: 900 })
    expect(sum([...stored, ...rest.lines])).toBe(0)
  })
})

// --- Properties ------------------------------------------------------------------------------

const saleArb = fc
  .record({
    grossCents: fc.integer({ min: 1, max: 10_000_000 }),
    taxShare: fc.double({ min: 0, max: 0.3, noNaN: true }),
    fee: fc.integer({ min: 0, max: 3_000 }),
    bps: fc.integer({ min: 0, max: 10_000 }),
    creatorPct: fc.integer({ min: 0, max: 100 }),
    ids: fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 2 }),
  })
  .map(({ grossCents, taxShare, fee, bps, creatorPct, ids }): SplitInput => ({
    grossCents,
    taxCents: Math.floor(grossCents * taxShare),
    stripeFeeCents: fee,
    takeRateBps: bps,
    members: [
      { userId: ids[0] ?? A, role: "creator", splitPct: creatorPct },
      { userId: ids[1] ?? B, role: "builder", splitPct: 100 - creatorPct },
    ],
  }))

/** A sale and a sequence of 1–6 refunds whose total is ≤ gross (sometimes exactly gross). */
const scenarioArb = saleArb.chain((input) =>
  fc
    .tuple(
      fc.array(fc.double({ min: 0.01, max: 1, noNaN: true }), { minLength: 1, maxLength: 6 }),
      fc.boolean(),
    )
    .map(([weights, full]) => {
      const total = weights.reduce((a, b) => a + b, 0)
      const target = full
        ? input.grossCents
        : Math.max(1, Math.floor(input.grossCents * Math.min(1, total / 6)))
      const amounts: number[] = []
      let given = 0
      weights.forEach((weight, index) => {
        const last = index === weights.length - 1
        const amount = last ? target - given : Math.floor((target * weight) / total)
        if (amount > 0) {
          amounts.push(amount)
          given += amount
        }
      })
      return { input, amounts }
    }),
)

/** Apply refunds one after another, rebuilding components from the stored lines each time. */
function applyRefunds(input: SplitInput, amounts: readonly number[]) {
  const sale = computeSplit(input)
  const stored: StoredOrderLine[] = sale.lines.map((line) => ({
    ...line,
    refundId: null,
    chargebackId: null,
  }))
  const refunds = amounts.map((amount, index) => {
    const components = componentsFromEntries(stored)
    const left = components.reduce((t, c) => t + c.saleCents - c.reversedCents, 0)
    const mirror = computeRefundMirror({ components, amountCents: amount })
    stored.push(
      ...mirror.lines.map((line) => ({ ...line, refundId: `r${index}`, chargebackId: null })),
    )
    return { amount, mirror, components, left }
  })
  return { sale, stored, refunds }
}

describe("refund mirrors: properties", () => {
  it("every refund sums to −amount; the order sums to gross − refunds", () => {
    fc.assert(
      fc.property(scenarioArb, ({ input, amounts }) => {
        const { stored, refunds } = applyRefunds(input, amounts)
        for (const refund of refunds) expect(sum(refund.mirror.lines)).toBe(-refund.amount)
        const refunded = amounts.reduce((a, b) => a + b, 0)
        expect(sum(stored)).toBe(input.grossCents - refunded)
      }),
      RUNS,
    )
  })

  it("never over-reverses a component nor reverses it the wrong way, and never a negative stripe_fee", () => {
    fc.assert(
      fc.property(scenarioArb, ({ input, amounts }) => {
        const { stored, refunds } = applyRefunds(input, amounts)
        for (const component of componentsFromEntries(stored)) {
          const left = component.saleCents - component.reversedCents
          if (component.saleCents >= 0) {
            expect(left).toBeGreaterThanOrEqual(0)
            expect(left).toBeLessThanOrEqual(component.saleCents)
          } else {
            expect(left).toBeLessThanOrEqual(0)
            expect(left).toBeGreaterThanOrEqual(component.saleCents)
          }
        }
        for (const refund of refunds) {
          for (const line of refund.mirror.lines) expect(line.account).not.toBe("stripe_fee")
          // Members only ever give money back.
          for (const line of refund.mirror.lines) {
            if (line.userId !== null) expect(line.amountCents).toBeLessThan(0)
          }
        }
      }),
      RUNS,
    )
  })

  it("refunding the whole order zeroes every component exactly", () => {
    fc.assert(
      fc.property(scenarioArb, ({ input, amounts }) => {
        const refunded = amounts.reduce((a, b) => a + b, 0)
        fc.pre(refunded === input.grossCents)
        const { stored } = applyRefunds(input, amounts)
        for (const component of componentsFromEntries(stored)) {
          expect(component.reversedCents).toBe(component.saleCents)
        }
        // Per ledger account (the Stripe fee stays, offset by the platform's adjustment).
        const byKey = new Map<string, number>()
        for (const line of stored) {
          const key = `${line.account}:${line.userId ?? ""}`
          byKey.set(key, (byKey.get(key) ?? 0) + line.amountCents)
        }
        for (const [key, total] of byKey) {
          if (key.startsWith("stripe_fee") || key.startsWith("adjustment")) continue
          expect({ key, total }).toEqual({ key, total: 0 })
        }
        expect((byKey.get("stripe_fee:") ?? 0) + (byKey.get("adjustment:") ?? 0)).toBe(0)
      }),
      RUNS,
    )
  })

  it("every component stays within two cents of its exact cumulative proportion", () => {
    fc.assert(
      fc.property(scenarioArb, ({ input, amounts }) => {
        const { stored, sale } = applyRefunds(input, amounts)
        const refunded = amounts.reduce((a, b) => a + b, 0)
        for (const component of componentsFromEntries(stored)) {
          const exact =
            (refunded * component.saleCents) / sale.lines.reduce((t, l) => t + l.amountCents, 0)
          expect(Math.abs(component.reversedCents - exact)).toBeLessThan(2)
        }
      }),
      RUNS,
    )
  })

  it("a refund larger than what is left is refused", () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer({ min: 1, max: 1000 }), ({ input, amounts }, extra) => {
        const { stored } = applyRefunds(input, amounts)
        const components = componentsFromEntries(stored)
        const left = components.reduce((t, c) => t + c.saleCents - c.reversedCents, 0)
        expect(() => computeRefundMirror({ components, amountCents: left + extra })).toThrow(
          expect.objectContaining({ code: "over_refund" }),
        )
      }),
      RUNS,
    )
  })

  it("chargebacks after partial refunds keep the order sum at gross − refunded − disputed", () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        ({ input, amounts }, fee, extra) => {
          const { stored } = applyRefunds(input, amounts)
          const components = componentsFromEntries(stored)
          const left = components.reduce((t, c) => t + c.saleCents - c.reversedCents, 0)
          fc.pre(left + extra > 0)
          // The dispute can exceed what is left (a dispute after a refund).
          const chargeback = computeChargebackMirror({ components, amountCents: left + extra })
          expect(sum(chargeback.lines)).toBe(-(left + extra))
          expect(chargeback.excessCents).toBe(extra)
          const after = [
            ...stored,
            ...[...chargeback.lines, ...disputeFeeLines(fee)].map((line) => ({
              ...line,
              refundId: null,
              chargebackId: "cb",
            })),
          ]
          expect(sum(after) + extra).toBe(0)
          // Nobody is reversed past zero, members included.
          for (const component of componentsFromEntries(after)) {
            expect(component.saleCents - component.reversedCents).toBe(0)
          }
        },
      ),
      RUNS,
    )
  })
})

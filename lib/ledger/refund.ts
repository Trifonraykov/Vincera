import { allocateLargestRemainder } from "./allocate"
import { LedgerError } from "./errors"
import { assertLinesSum } from "./split"
import type { LedgerLine } from "./types"

/**
 * Refund and chargeback mirrors (§9 "Refunds", §19.10; CLAUDE.md §19.31, §19.33): pure functions
 * over integer cents.
 *
 * An order's sale is split into components (`tax`, `stripe_fee`, `platform_fee` and one share per
 * member). A refund is computed on the **cumulative** refunded amount (earlier refunds and
 * chargebacks plus this one): its largest-remainder split over the sale lines, ties to the platform
 * lines first (tax, Stripe fee, platform fee), then the lower user id, minus what each component
 * already gave back (§19.31). Consequences:
 * - a refund's lines sum to −amount exactly;
 * - no component is ever reversed past zero, nor in the wrong direction (a component's part is kept
 *   inside `[0, what is left]`), however many partial refunds come;
 * - refunding everything that is left zeroes every component exactly, so a full refund (or the
 *   last of several partial ones) leaves the order at 0;
 * - after any number of refunds each component's total reversal is within two cents of its exact
 *   proportional share (property-tested).
 *
 * Stripe keeps its fee on a refund (§19.10): the Stripe-fee component is reversed as an
 * `adjustment` line (user null, the platform absorbs the unreturned fee), never as a negative
 * `stripe_fee`. A dispute fee is booked as `stripe_fee +fee` and `adjustment −fee` when Stripe
 * withdraws it (the platform absorbs it too), and a lost chargeback's lines sum to −amount.
 */

export type MirrorAccount =
  "tax" | "stripe_fee" | "platform_fee" | "creator_share" | "builder_share"

/** One component of an order's sale and how much of it earlier refunds already reversed. */
export type SaleComponent = {
  account: MirrorAccount
  userId: string | null
  /** The sale line's amount (`computeSplit` line; negative only for a loss-making platform fee). */
  saleCents: number
  /** Already reversed by earlier refunds/chargebacks, in the sale's direction (≥ 0 for a positive sale). */
  reversedCents: number
}

export type MirrorAllocation = {
  account: MirrorAccount
  userId: string | null
  /** The part of the refund this component gives back (same sign as the sale line, or 0). */
  reversedCents: number
}

export type RefundMirror = {
  /** Per component, in the tie-break order. */
  allocations: MirrorAllocation[]
  /** The ledger lines to write (zero lines left out); they sum to −amount. */
  lines: LedgerLine[]
}

const PLATFORM_ORDER: Record<MirrorAccount, number> = {
  tax: 0,
  stripe_fee: 1,
  platform_fee: 2,
  creator_share: 3,
  builder_share: 3,
}

/** The tie-break order: tax, Stripe fee, platform fee, then members by user id (string order). */
export function orderComponents<T extends { account: MirrorAccount; userId: string | null }>(
  components: readonly T[],
): T[] {
  return [...components].sort((a, b) => {
    const byAccount = PLATFORM_ORDER[a.account] - PLATFORM_ORDER[b.account]
    if (byAccount !== 0) return byAccount
    const left = a.userId ?? ""
    const right = b.userId ?? ""
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** What is left of the order to refund: Σ (sale − reversed). */
export function refundableCents(components: readonly SaleComponent[]): number {
  return components.reduce((sum, c) => sum + c.saleCents - c.reversedCents, 0)
}

/** The mirror lines of a refund of `amountCents` (> 0, ≤ what is left). */
export function computeRefundMirror(input: {
  components: readonly SaleComponent[]
  amountCents: number
}): RefundMirror {
  const { amountCents } = input
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new LedgerError("invalid_input", `refund amount must be > 0 cents, got ${amountCents}`)
  }
  const components = orderComponents(validateComponents(input.components))
  const left = refundableCents(components)
  if (amountCents > left) {
    throw new LedgerError(
      "over_refund",
      `refund of ${amountCents} exceeds the ${left} cents left on the order`,
    )
  }

  const parts = allocateCumulative(components, amountCents)
  const allocations = components.map((c, index) => ({
    account: c.account,
    userId: c.userId,
    reversedCents: parts[index] ?? 0,
  }))
  const lines: LedgerLine[] = allocations
    .filter((a) => a.reversedCents !== 0)
    .map((a) =>
      a.account === "stripe_fee"
        ? // Stripe keeps its fee: the platform absorbs it (§19.10).
          { account: "adjustment", userId: null, amountCents: -a.reversedCents }
        : { account: a.account, userId: a.userId, amountCents: -a.reversedCents },
    )
  assertLinesSum(lines, -amountCents, "refund mirror")
  return { allocations, lines }
}

/**
 * The refund's part per component: the largest-remainder split of the **cumulative** refunded
 * amount over the sale (so cumulative reversals stay within a cent or two of exact, however many
 * partial refunds came) minus what each component already gave back, kept inside
 * `[0, what is left]` (never past zero, never the wrong way). When keeping it inside moved cents,
 * they go one at a time to the component furthest behind its exact cumulative share (ahead, when
 * taking back), ties in the tie-break order. Refunding everything that is left gives each
 * component exactly its remainder.
 */
function allocateCumulative(components: readonly SaleComponent[], amountCents: number): number[] {
  const gross = components.reduce((sum, c) => sum + c.saleCents, 0)
  const before = components.reduce((sum, c) => sum + c.reversedCents, 0)
  const cumulative = before + amountCents
  const targets = allocateLargestRemainder(
    cumulative,
    components.map((c) => c.saleCents),
    gross,
  )

  const bounds = components.map((c) => {
    const left = c.saleCents - c.reversedCents
    return c.saleCents >= 0 ? { lo: 0, hi: left } : { lo: left, hi: 0 }
  })
  const parts = components.map((c, index) => {
    const bound = bounds[index] ?? { lo: 0, hi: 0 }
    const wanted = (targets[index] ?? 0) - c.reversedCents
    return Math.min(bound.hi, Math.max(bound.lo, wanted))
  })

  // How far behind its exact cumulative share a component is, scaled by gross (integers).
  const behind = (index: number) => {
    const c = components[index]
    if (!c) return 0
    return cumulative * c.saleCents - (c.reversedCents + (parts[index] ?? 0)) * gross
  }
  let diff = amountCents - parts.reduce((sum, part) => sum + part, 0)
  while (diff !== 0) {
    const step = diff > 0 ? 1 : -1
    let best = -1
    for (let index = 0; index < parts.length; index += 1) {
      const bound = bounds[index] ?? { lo: 0, hi: 0 }
      const part = parts[index] ?? 0
      if (step > 0 ? part >= bound.hi : part <= bound.lo) continue
      if (best === -1 || (step > 0 ? behind(index) > behind(best) : behind(index) < behind(best))) {
        best = index
      }
    }
    if (best === -1) {
      throw new LedgerError("sum_mismatch", "refund mirror: no component left to adjust")
    }
    parts[best] = (parts[best] ?? 0) + step
    diff -= step
  }
  return parts
}

export type ChargebackMirror = RefundMirror & {
  /** The part of the disputed amount mirrored over the order's components (≤ what was left). */
  mirroredCents: number
  /** What Stripe took beyond what was left of the order (refunded first, disputed after): a platform loss. */
  excessCents: number
}

/**
 * A lost chargeback: the refund mirror of the disputed amount, capped at what is left of the order
 * (CLAUDE.md §19.37). Stripe lets a buyer dispute the whole charge after a partial or full refund,
 * so the platform can lose more than the order had left; that excess is an `adjustment` line (user
 * null), a platform loss the members do not share. Lines sum to −amount. The dispute fee is booked
 * separately when Stripe withdraws it (`disputeFeeLines`).
 */
export function computeChargebackMirror(input: {
  components: readonly SaleComponent[]
  amountCents: number
}): ChargebackMirror {
  const { amountCents } = input
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new LedgerError(
      "invalid_input",
      `chargeback amount must be > 0 cents, got ${amountCents}`,
    )
  }
  const components = orderComponents(validateComponents(input.components))
  const mirroredCents = Math.max(0, Math.min(amountCents, refundableCents(components)))
  const excessCents = amountCents - mirroredCents
  const mirror: RefundMirror =
    mirroredCents > 0
      ? computeRefundMirror({ components, amountCents: mirroredCents })
      : {
          allocations: components.map((c) => ({
            account: c.account,
            userId: c.userId,
            reversedCents: 0,
          })),
          lines: [],
        }
  const lines: LedgerLine[] =
    excessCents > 0
      ? [...mirror.lines, { account: "adjustment", userId: null, amountCents: -excessCents }]
      : mirror.lines
  assertLinesSum(lines, -amountCents, "chargeback mirror")
  return { allocations: mirror.allocations, lines, mirroredCents, excessCents }
}

/**
 * The dispute fee Stripe withdrew (positive delta) or returned (negative delta), as a platform pair
 * `stripe_fee +delta` / `adjustment −delta` (§9 "ledger entries for every component"; the platform
 * absorbs the fee, CLAUDE.md §19.31). The pair sums to 0, so order sums do not move, and
 * `componentsFromEntries` cancels it out of the Stripe-fee component.
 */
export function disputeFeeLines(deltaCents: number): LedgerLine[] {
  if (!Number.isSafeInteger(deltaCents)) {
    throw new LedgerError("invalid_input", `dispute fee change must be integer cents`)
  }
  if (deltaCents === 0) return []
  return [
    { account: "stripe_fee", userId: null, amountCents: deltaCents },
    { account: "adjustment", userId: null, amountCents: -deltaCents },
  ]
}

/** A stored ledger line of an order, as `componentsFromEntries` reads it. */
export type StoredOrderLine = {
  account: string
  userId: string | null
  amountCents: number
  /** Set on a refund's or chargeback's lines. */
  refundId: string | null
  chargebackId: string | null
}

/**
 * Rebuild an order's components from its stored lines. Sale lines are those without a refund or
 * chargeback (a failed payout's release lines, a mirror and a re-issue, cancel out per component).
 * Reversed amounts come from the refund/chargeback lines: `adjustment` and `stripe_fee` lines with
 * a cause both count toward the Stripe-fee component, so a chargeback's dispute-fee pair
 * (+fee, −fee) cancels out.
 */
export function componentsFromEntries(lines: readonly StoredOrderLine[]): SaleComponent[] {
  const byKey = new Map<string, SaleComponent>()
  const keyOf = (account: MirrorAccount, userId: string | null) => `${account}:${userId ?? ""}`
  const ensure = (account: MirrorAccount, userId: string | null) => {
    const key = keyOf(account, userId)
    let component = byKey.get(key)
    if (!component) {
      component = { account, userId, saleCents: 0, reversedCents: 0 }
      byKey.set(key, component)
    }
    return component
  }

  for (const line of lines) {
    const isCause = line.refundId !== null || line.chargebackId !== null
    if (!isCause) {
      if (isMirrorAccount(line.account))
        ensure(line.account, line.userId).saleCents += line.amountCents
      continue
    }
    if (line.account === "adjustment" || line.account === "stripe_fee") {
      if (line.userId === null) ensure("stripe_fee", null).reversedCents -= line.amountCents
      continue
    }
    if (isMirrorAccount(line.account)) {
      ensure(line.account, line.userId).reversedCents -= line.amountCents
    }
  }
  // A lost chargeback's excess (`computeChargebackMirror`) is an unpaired platform `adjustment`
  // that lands on the Stripe-fee component above. It only exists once every component is fully
  // reversed, so the component is capped at its sale amount: nothing is left either way.
  const fee = byKey.get(keyOf("stripe_fee", null))
  if (fee && fee.saleCents >= 0 && fee.reversedCents > fee.saleCents) {
    fee.reversedCents = fee.saleCents
  }
  return [...byKey.values()]
}

function isMirrorAccount(account: string): account is MirrorAccount {
  return account in PLATFORM_ORDER
}

function validateComponents(components: readonly SaleComponent[]): SaleComponent[] {
  if (components.length === 0) {
    throw new LedgerError("invalid_state", "the order has no sale lines to refund")
  }
  const seen = new Set<string>()
  for (const c of components) {
    const key = `${c.account}:${c.userId ?? ""}`
    if (seen.has(key)) throw new LedgerError("invalid_input", `duplicate component ${key}`)
    seen.add(key)
    if (!Number.isSafeInteger(c.saleCents) || !Number.isSafeInteger(c.reversedCents)) {
      throw new LedgerError("invalid_input", "component amounts must be integer cents")
    }
    const left = c.saleCents - c.reversedCents
    // Never past zero and never in the wrong direction (an earlier over-reversal is a bug).
    if (c.saleCents >= 0 ? left < 0 || left > c.saleCents : left > 0 || left < c.saleCents) {
      throw new LedgerError("invalid_state", `component ${key} is reversed past its sale amount`)
    }
  }
  return [...components]
}

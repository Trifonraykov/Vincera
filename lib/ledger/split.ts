import type { CollabRole, LedgerAccount } from "@/lib/db/schema/enums"

import { allocateLargestRemainder } from "./allocate"
import { LedgerError } from "./errors"
import type { LedgerLine, SplitInput, SplitMember, SplitResult } from "./types"

/**
 * The §9 split (CLAUDE.md §19.31 "Ledger", §19.33): a pure function over integer cents.
 *
 *     net            = gross − tax − stripe_fee
 *     platform_fee   = round_half_up(net × takeRateBps / 10 000)       (net > 0)
 *                    = net                                             (net ≤ 0: the platform
 *                                                                       carries the loss)
 *     distributable  = net − platform_fee
 *     member share   = distributable × split_pct / 100, largest remainder, ties → lower user id
 *
 * `lines` holds `tax`, `stripe_fee`, `platform_fee` (user null) and one `<role>_share` per member
 * with a non-zero share, in that order (members by user id). They always sum to gross: asserted.
 *
 * When `tax + stripe_fee > gross` (impossible at Stripe's minimum charge, but defined): net is
 * negative, the `platform_fee` line is negative (the platform pays the difference) and members
 * get nothing.
 */
export function computeSplit(input: SplitInput): SplitResult {
  const { grossCents, taxCents, stripeFeeCents, takeRateBps: bps } = input
  assertCents(grossCents, "grossCents")
  assertCents(taxCents, "taxCents")
  assertCents(stripeFeeCents, "stripeFeeCents")
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new LedgerError("invalid_input", `takeRateBps must be an integer 0–10000, got ${bps}`)
  }
  const members = validateMembers(input.members)

  const netCents = grossCents - taxCents - stripeFeeCents
  const platformFeeCents = netCents > 0 ? roundHalfUpDiv(netCents * bps, 10_000) : netCents
  const distributableCents = netCents - platformFeeCents

  const amounts = allocateLargestRemainder(
    distributableCents,
    members.map((member) => member.splitPct),
    100,
  )
  const shares = members.map((member, index) => ({
    userId: member.userId,
    role: member.role,
    amountCents: amounts[index] ?? 0,
  }))

  const allLines: LedgerLine[] = [
    { account: "tax", userId: null, amountCents: taxCents },
    { account: "stripe_fee", userId: null, amountCents: stripeFeeCents },
    { account: "platform_fee", userId: null, amountCents: platformFeeCents },
    ...shares.map((share) => ({
      account: shareAccount(share.role),
      userId: share.userId,
      amountCents: share.amountCents,
    })),
  ]
  const lines = allLines.filter((line) => line.amountCents !== 0)

  assertLinesSum(lines, grossCents, "split")
  return { netCents, platformFeeCents, distributableCents, shares, lines }
}

/** PLATFORM_TAKE_RATE (0–1) in basis points, so fees are integer arithmetic. */
export function takeRateBps(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError("PLATFORM_TAKE_RATE must be between 0 and 1")
  }
  return Math.round(rate * 10_000)
}

/** The ledger account of a member's share. */
export function shareAccount(role: CollabRole): LedgerAccount {
  return role === "creator" ? "creator_share" : "builder_share"
}

/** Throws `sum_mismatch` unless the lines add up to `expected` (the §9 assertion). */
export function assertLinesSum(
  lines: readonly { amountCents: number }[],
  expected: number,
  label: string,
): void {
  let total = 0
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountCents)) {
      throw new LedgerError("invalid_input", `${label}: a line is not integer cents`)
    }
    total += line.amountCents
  }
  if (total !== expected) {
    throw new LedgerError("sum_mismatch", `${label}: lines sum to ${total}, expected ${expected}`)
  }
}

/** round(n / d) half up, for n ≥ 0, d > 0, in integers. */
function roundHalfUpDiv(n: number, d: number): number {
  if (!Number.isSafeInteger(n)) {
    throw new LedgerError("invalid_input", "amount too large for exact arithmetic")
  }
  const quotient = Math.floor(n / d)
  const remainder = n - quotient * d
  return remainder * 2 >= d ? quotient + 1 : quotient
}

function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LedgerError("invalid_input", `${label} must be integer cents ≥ 0, got ${value}`)
  }
}

/** Members sorted by user id (the tie-break order), checked: distinct, integer 0–100, sum 100. */
function validateMembers(members: readonly SplitMember[]): SplitMember[] {
  if (members.length === 0) {
    throw new LedgerError("invalid_members", "a split needs at least one member")
  }
  const seen = new Set<string>()
  let total = 0
  for (const member of members) {
    if (!member.userId || seen.has(member.userId)) {
      throw new LedgerError("invalid_members", "members must have distinct user ids")
    }
    seen.add(member.userId)
    if (!Number.isSafeInteger(member.splitPct) || member.splitPct < 0 || member.splitPct > 100) {
      throw new LedgerError("invalid_members", `split_pct must be 0–100, got ${member.splitPct}`)
    }
    if (member.role !== "creator" && member.role !== "builder") {
      throw new LedgerError("invalid_members", "a member's role must be creator or builder")
    }
    total += member.splitPct
  }
  if (total !== 100) {
    throw new LedgerError("invalid_members", `member splits sum to ${total}, expected 100`)
  }
  // Plain string order (not locale order), so the tie-break is the same everywhere.
  return [...members].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
}

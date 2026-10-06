import { LedgerError } from "./errors"

/**
 * Integer apportionment by the largest-remainder (Hamilton) method, the one rounding rule of the
 * ledger (§9): `total` is split over `weights` in proportion `weight / denominator`, each part is
 * rounded down, and the cents left over go one each to the parts with the largest remainders.
 * Equal remainders go to the earlier part, so callers order `weights` by their tie-break rule.
 *
 * Exact integer arithmetic throughout (no floats): `total × weight` must stay a safe integer.
 *
 * Guarantees, when `Σ weights = denominator` and `0 ≤ total ≤ denominator` (refunds) or the
 * weights are percentages (splits):
 * - the parts sum to `total` exactly;
 * - each part is within one cent of `total × weight / denominator` (floor or ceil of it);
 * - a part has the sign of its weight (or is 0), and never exceeds the weight in magnitude when
 *   `total ≤ denominator`.
 */
export function allocateLargestRemainder(
  total: number,
  weights: readonly number[],
  denominator: number,
): number[] {
  if (!Number.isSafeInteger(total)) {
    throw new LedgerError("invalid_input", `allocate: total must be an integer, got ${total}`)
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new LedgerError("invalid_input", `allocate: denominator must be > 0, got ${denominator}`)
  }
  const weightSum = weights.reduce((sum, weight) => {
    if (!Number.isSafeInteger(weight)) {
      throw new LedgerError("invalid_input", `allocate: weights must be integers, got ${weight}`)
    }
    return sum + weight
  }, 0)
  if (weightSum !== denominator) {
    throw new LedgerError(
      "invalid_input",
      `allocate: weights sum to ${weightSum}, expected ${denominator}`,
    )
  }

  const parts = weights.map((weight, index) => {
    const product = total * weight
    if (!Number.isSafeInteger(product)) {
      throw new LedgerError("invalid_input", "allocate: amount too large for exact arithmetic")
    }
    // Floor division that is exact for negative products too; remainder in [0, denominator).
    const quotient = Math.floor(product / denominator)
    let floor = quotient
    let remainder = product - floor * denominator
    // `product / denominator` is a float; correct the (rare) off-by-one of huge values.
    while (remainder < 0) {
      floor -= 1
      remainder += denominator
    }
    while (remainder >= denominator) {
      floor += 1
      remainder -= denominator
    }
    return { index, floor, remainder }
  })

  let leftover = total - parts.reduce((sum, part) => sum + part.floor, 0)
  // Σ remainders = leftover × denominator, so leftover < parts with a remainder (each < denominator).
  const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  const result = parts.map((part) => part.floor)
  for (const part of byRemainder) {
    if (leftover <= 0) break
    if (part.remainder === 0) break
    result[part.index] = (result[part.index] ?? 0) + 1
    leftover -= 1
  }
  if (leftover !== 0) {
    throw new LedgerError("sum_mismatch", `allocate: ${leftover} cents left unallocated`)
  }
  return result
}

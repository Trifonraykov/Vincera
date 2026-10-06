/**
 * Money is always an integer number of minor units ("cents") plus a currency code (§0).
 * Floats are only used at the very edge, to display a value.
 */

export const DEFAULT_CURRENCY = "eur"
export const DEFAULT_LOCALE = "en-US"

export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MoneyError"
  }
}

export function isIntegerCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

/** Throws unless `value` is a safe integer (negative allowed: refunds and ledger reversals). */
export function assertIntegerCents(value: unknown, label = "amount"): asserts value is number {
  if (!isIntegerCents(value)) {
    throw new MoneyError(`${label} must be an integer number of cents, got ${String(value)}`)
  }
}

/** Like assertIntegerCents, and also rejects negative amounts. */
export function assertNonNegativeCents(value: unknown, label = "amount"): asserts value is number {
  assertIntegerCents(value, label)
  if (value < 0) throw new MoneyError(`${label} must not be negative, got ${value}`)
}

/** Sum integer cents, failing loudly on non-integers or overflow past Number.MAX_SAFE_INTEGER. */
export function sumCents(values: Iterable<number>): number {
  let total = 0
  for (const value of values) {
    assertIntegerCents(value)
    total += value
  }
  assertIntegerCents(total, "total")
  return total
}

function minorUnitDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  )
}

/** Format integer minor units for display, e.g. formatMoney(1999, "eur") → "€19.99". */
export function formatMoney(
  cents: number,
  currency: string = DEFAULT_CURRENCY,
  locale: string = DEFAULT_LOCALE,
): string {
  assertIntegerCents(cents)
  const code = currency.toUpperCase()
  const digits = minorUnitDigits(code)
  return new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(
    cents / 10 ** digits,
  )
}

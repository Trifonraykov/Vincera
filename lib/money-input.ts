import { DEFAULT_CURRENCY } from "./money"

/**
 * Money typed by a person (a price field) ↔ integer minor units (§0: money is cents everywhere).
 * Client-safe: forms show the stored cents with `formatMoneyInput`, servers parse what was typed
 * with `parseMoneyInput`, so a float never reaches the database.
 *
 * Accepted: digits with an optional decimal part of up to the currency's minor digits, using `.`
 * or `,` as the decimal separator ("19", "19.9", "19,99"), thousands separators that are spaces,
 * thin spaces or apostrophes ("1 299", "1'299.50"), and a leading or trailing currency sign or
 * code ("€19", "19 EUR"). Not accepted: negative amounts, exponents, more decimals than the
 * currency has, and ambiguous groupings such as "1.299,00" (we cannot tell which mark is which).
 */

export type MoneyInputResult =
  | { ok: true; cents: number | null }
  | { ok: false; reason: "invalid" | "too_many_decimals" | "too_large" }

/** Digits after the decimal mark for `currency` (EUR 2, JPY 0). */
export function currencyMinorDigits(currency: string = DEFAULT_CURRENCY): number {
  return (
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).resolvedOptions().maximumFractionDigits ?? 2
  )
}

/** The currency's symbol on its own, e.g. "€" for eur (for the field's prefix). */
export function currencySymbol(currency: string = DEFAULT_CURRENCY, locale = "en-US"): string {
  const part = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
  })
    .formatToParts(0)
    .find((entry) => entry.type === "currency")
  return part?.value ?? currency.toUpperCase()
}

const SIGNS = /^[\s€$£¥]+|[\s€$£¥]+$/g
const GROUPING = /[\s   ']/g

/**
 * "19,99" → 1999 cents (EUR). Empty input is `{ ok: true, cents: null }` (no price). `max` is in
 * cents and inclusive.
 */
export function parseMoneyInput(
  value: string,
  options: { currency?: string; max?: number } = {},
): MoneyInputResult {
  const currency = (options.currency ?? DEFAULT_CURRENCY).toLowerCase()
  const digits = currencyMinorDigits(currency)
  // The field's own currency code may lead or trail ("EUR 19", "19 eur"); no other letters.
  const code = new RegExp(`^${currency}\\s*|\\s*${currency}$`, "i")
  const cleaned = value.trim().replace(code, "").replace(SIGNS, "").replace(GROUPING, "")
  if (cleaned === "") return { ok: true, cents: null }

  const match = /^(\d+)(?:[.,](\d*))?$/.exec(cleaned)
  if (!match) return { ok: false, reason: "invalid" }
  const [, whole = "", fraction = ""] = match
  if (fraction.length > digits) return { ok: false, reason: "too_many_decimals" }
  if (whole.length > 12) return { ok: false, reason: "too_large" }

  const cents = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0")
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: "too_large" }
  if (options.max !== undefined && cents > options.max) return { ok: false, reason: "too_large" }
  return { ok: true, cents }
}

/**
 * 1999 → "19.99", 1900 → "19" (whole amounts without decimals), null → "": the value a price
 * field starts with. Always `.` as the decimal mark and no grouping, so it parses back exactly.
 */
export function formatMoneyInput(
  cents: number | null,
  currency: string = DEFAULT_CURRENCY,
): string {
  if (cents === null) return ""
  const digits = currencyMinorDigits(currency)
  const unit = 10 ** digits
  const whole = Math.trunc(cents / unit)
  const fraction = cents % unit
  if (fraction === 0) return String(whole)
  return `${whole}.${String(fraction).padStart(digits, "0")}`
}

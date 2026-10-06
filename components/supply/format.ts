import { formatMoney } from "@/lib/money"

/** Dates and prices on supply pages: fixed locale and UTC, so server and client agree. */

const dateOnly = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })

export function formatDay(date: Date): string {
  return dateOnly.format(date)
}

/** "€19" for whole amounts, "€19.99" otherwise; null → null (no price set). */
export function formatPrice(cents: number | null, currency: string): string | null {
  if (cents === null) return null
  const text = formatMoney(cents, currency)
  return cents % 100 === 0 ? text.replace(/\.00$/, "") : text
}

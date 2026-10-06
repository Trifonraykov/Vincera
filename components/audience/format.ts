/**
 * Number, percentage, country and date formatting for audience data. Client-safe and
 * deterministic (fixed `en` locale, UTC dates), so server and client render the same text.
 */

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const regionNames = new Intl.DisplayNames(["en"], { type: "region" })
const dateTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
})
const dateOnly = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })

/** 12345 → "12,345"; null → "—". */
export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : integer.format(value)
}

/** 12345 → "12.3K"; null → "—". */
export function formatCompact(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : compact.format(value)
}

/** 0.1234 → "12.3%" (shares and engagement rates are fractions). */
export function formatPercent(share: number | null | undefined, digits = 1): string {
  if (share === null || share === undefined) return "—"
  return `${(share * 100).toFixed(digits)}%`
}

/** "DE" → "Germany"; unknown codes stay as they are. */
export function countryLabel(code: string): string {
  try {
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

export function formatDateTimeUtc(date: Date): string {
  return `${dateTime.format(date)} UTC`
}

export function formatDate(date: Date): string {
  return dateOnly.format(date)
}

/** "18-24" → "18–24", "65+" stays. */
export function ageGroupLabel(group: string): string {
  return group.replace("-", "–")
}

export const GENDER_LABELS = {
  female: "Female",
  male: "Male",
  other: "Other or unspecified",
} as const
export type GenderGroup = keyof typeof GENDER_LABELS

/** YouTube's "user specified" and Instagram's "unknown" share one group. */
export function genderGroup(gender: "female" | "male" | "other" | "unknown"): GenderGroup {
  return gender === "female" || gender === "male" ? gender : "other"
}

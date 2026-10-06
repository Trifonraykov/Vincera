/**
 * Pure helpers that turn provider numbers into `AudienceSnapshotInput` fields (§5, §7.1).
 * Client-safe and side-effect free.
 */

/** Largest value of a Postgres `integer` column (followers, avg_views). */
export const PG_INT_MAX = 2_147_483_647

/** A non-negative integer that fits an `integer` column, or null. */
export function toCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.min(Math.max(Math.round(value), 0), PG_INT_MAX)
}

/** Round to 4 decimals (numeric(6,4)). */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * Engagement rate as stored (numeric(6,4)): interactions ÷ views, clamped to 0–99 and rounded to
 * 4 decimals. Null when there are no views to divide by.
 */
export function engagementRate(interactions: number, views: number): number | null {
  if (!Number.isFinite(interactions) || !Number.isFinite(views) || views <= 0) return null
  return round4(Math.min(Math.max(interactions / views, 0), 99))
}

/** A 0–1 share rounded to 4 decimals. */
export function toShare(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0
  return round4(Math.min(Math.max(part / total, 0), 1))
}

/** Mean of the values, rounded to an integer count; null for an empty list. */
export function averageCount(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return toCount(values.reduce((sum, v) => sum + v, 0) / values.length)
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/** An http(s) URL, or null (provider avatar/profile links are not always well-formed). */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
  } catch {
    return null
  }
}

/** Seconds in an ISO 8601 duration such as `PT1H2M3S` or `P1DT2H` (YouTube); null if invalid. */
export function isoDurationSeconds(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value)
  if (!match || value === "P" || value.endsWith("T")) return null
  const [, d = "0", h = "0", m = "0", s = "0"] = match
  return Math.round(Number(d) * 86_400 + Number(h) * 3_600 + Number(m) * 60 + Number(s))
}

/** `YYYY-MM-DD` of a date in UTC. */
export function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export const DAY_MS = 86_400_000

/** Text with control characters removed and whitespace collapsed, capped at `max` characters. */
export function cleanText(value: string | null | undefined, max = 200): string | null {
  if (!value) return null
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned) return null
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

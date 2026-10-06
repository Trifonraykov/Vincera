import { z } from "zod"

/**
 * UTC date ranges for the analytics pages (client-safe; CLAUDE.md §19.38). A range is two
 * inclusive UTC days, `from` ≤ `to`; queries use `[start of from, start of the day after to)`.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

export type DayRange = {
  /** `YYYY-MM-DD`, inclusive. */
  from: string
  /** `YYYY-MM-DD`, inclusive. */
  to: string
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const daySchema = z
  .string()
  .regex(dayPattern)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  })

/** The UTC day of an instant, `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00Z`)
}

/** `[start, end)` instants of a range. */
export function rangeBounds(range: DayRange): { start: Date; end: Date } {
  return { start: dayStart(range.from), end: new Date(dayStart(range.to).getTime() + DAY_MS) }
}

export function rangeDays(range: DayRange): string[] {
  const days: string[] = []
  const end = dayStart(range.to).getTime()
  for (let at = dayStart(range.from).getTime(); at <= end; at += DAY_MS) {
    days.push(utcDay(new Date(at)))
  }
  return days
}

export function rangeLength(range: DayRange): number {
  return Math.round((dayStart(range.to).getTime() - dayStart(range.from).getTime()) / DAY_MS) + 1
}

/** The last `days` UTC days ending today. */
export function lastDays(days: number, now: Date): DayRange {
  const to = utcDay(now)
  return { from: utcDay(new Date(dayStart(to).getTime() - (days - 1) * DAY_MS)), to }
}

/**
 * The range from `?from=&to=` search params: both valid days, `from` ≤ `to`, at most `maxDays`
 * long and not after today. Anything else falls back to the last `defaultDays` days; a range
 * that is too long keeps its end and is cut to `maxDays`.
 */
export function parseDayRange(
  params: { from?: unknown; to?: unknown },
  options: { now: Date; defaultDays: number; maxDays: number },
): DayRange {
  const fallback = lastDays(options.defaultDays, options.now)
  const from = daySchema.safeParse(params.from)
  const to = daySchema.safeParse(params.to)
  if (!from.success || !to.success) return fallback
  const today = utcDay(options.now)
  const end = to.data > today ? today : to.data
  if (from.data > end) return fallback
  const range = { from: from.data, to: end }
  if (rangeLength(range) <= options.maxDays) return range
  return {
    from: utcDay(new Date(dayStart(end).getTime() - (options.maxDays - 1) * DAY_MS)),
    to: end,
  }
}

/** Preset ranges offered by the range picker. */
export const RANGE_PRESETS = [7, 30, 90, 365] as const

/** A step's conversion from the previous one (0–1), or null when the previous is 0. */
export function conversion(step: number, previous: number): number | null {
  return previous > 0 ? step / previous : null
}

export function formatRate(rate: number | null): string {
  if (rate === null) return "–"
  const pct = rate * 100
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`
}

/** "5 Oct" style label of a `YYYY-MM-DD` day (UTC). */
export function shortDay(day: string): string {
  return dayStart(day).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
}

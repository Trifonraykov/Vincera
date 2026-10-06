import "server-only"

import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm"
import { z } from "zod"

import type { DbOrTx } from "@/lib/db/client"
import { events } from "@/lib/db/schema"
import type { EventContext, JsonObject } from "@/lib/db/schema/types"
import { EVENT_TYPES, SUBJECT_TYPES } from "@/lib/events/types"

import { parseDayRange, rangeBounds, rangeDays, type DayRange } from "./range"

/**
 * `/admin/events` (v1; CLAUDE.md §19.38): the event log with filters (type, subject type and id,
 * actor id, UTC day range ≤ 90 days), keyset pages of 50 on `(occurred_at, id)` newest first, and
 * counts by type per day over the same filters. Events hold ids, enums, counts and amounts only
 * (§11, the PII guard in lib/events/pii.ts), so nothing here needs redacting; pages render the
 * properties as escaped JSON text. The caller authorizes (`canViewEvents`).
 */

export const EVENTS_PAGE_SIZE = 50
export const EVENTS_MAX_DAYS = 90
export const EVENTS_DEFAULT_DAYS = 7

export type EventFilters = {
  type: string | null
  subjectType: string | null
  subjectId: string | null
  actorId: string | null
  range: DayRange
}

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional()).catch(undefined)

const filtersSchema = z.object({
  type: optional(z.enum(EVENT_TYPES)),
  subjectType: optional(z.enum(SUBJECT_TYPES)),
  subjectId: optional(z.uuid()),
  actorId: optional(z.uuid()),
})

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Filters from the page's search params; anything invalid is dropped (never an error page). */
export function parseEventFilters(params: SearchParams, at: Date): EventFilters {
  const parsed = filtersSchema.parse({
    type: first(params.type),
    subjectType: first(params.subject_type),
    subjectId: first(params.subject_id)?.trim().toLowerCase(),
    actorId: first(params.actor_id)?.trim().toLowerCase(),
  })
  return {
    type: parsed.type ?? null,
    subjectType: parsed.subjectType ?? null,
    subjectId: parsed.subjectId ?? null,
    actorId: parsed.actorId ?? null,
    range: parseDayRange(
      { from: first(params.from), to: first(params.to) },
      { now: at, defaultDays: EVENTS_DEFAULT_DAYS, maxDays: EVENTS_MAX_DAYS },
    ),
  }
}

export type EventCursor = { occurredAt: string; id: string }

const cursorPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f-]{36})$/

export function parseEventCursor(value: string | string[] | undefined): EventCursor | null {
  const match = cursorPattern.exec(first(value) ?? "")
  if (!match?.[1] || !match[2] || !z.uuid().safeParse(match[2]).success) return null
  return { occurredAt: match[1], id: match[2] }
}

export function formatEventCursor(cursor: EventCursor): string {
  return `${cursor.occurredAt}_${cursor.id}`
}

function conditions(filters: EventFilters): SQL[] {
  const { start, end } = rangeBounds(filters.range)
  const list: SQL[] = [gte(events.occurredAt, start), lt(events.occurredAt, end)]
  if (filters.type) list.push(eq(events.type, filters.type))
  if (filters.subjectType) list.push(eq(events.subjectType, filters.subjectType))
  if (filters.subjectId) list.push(eq(events.subjectId, filters.subjectId))
  if (filters.actorId) list.push(eq(events.actorUserId, filters.actorId))
  return list
}

export type ExplorerEvent = {
  id: string
  type: string
  occurredAt: Date
  actorUserId: string | null
  subjectType: string | null
  subjectId: string | null
  properties: JsonObject
  context: EventContext
}

/** Microsecond-exact UTC text of `occurred_at`, so the keyset never skips or repeats a row. */
const exactTime = sql<string>`to_char(${events.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

export async function listEvents(
  database: DbOrTx,
  filters: EventFilters,
  cursor: EventCursor | null,
): Promise<{ events: ExplorerEvent[]; next: EventCursor | null }> {
  const where = conditions(filters)
  if (cursor) {
    where.push(
      sql`(${events.occurredAt}, ${events.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`,
    )
  }
  const rows = await database
    .select({
      id: events.id,
      type: events.type,
      occurredAt: events.occurredAt,
      exact: exactTime,
      actorUserId: events.actorUserId,
      subjectType: events.subjectType,
      subjectId: events.subjectId,
      properties: events.properties,
      context: events.context,
    })
    .from(events)
    .where(and(...where))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(EVENTS_PAGE_SIZE + 1)
  const page = rows.slice(0, EVENTS_PAGE_SIZE)
  const last = page.at(-1)
  return {
    events: page.map(({ exact: _exact, ...row }) => row),
    next: rows.length > EVENTS_PAGE_SIZE && last ? { occurredAt: last.exact, id: last.id } : null,
  }
}

export type TypeCounts = { type: string; total: number; daily: number[] }

/**
 * Counts by type per UTC day over the filters' range (every day present, zeros included), types
 * by total, largest first; plus the daily totals across types.
 */
export async function countEventsByTypePerDay(
  database: DbOrTx,
  filters: EventFilters,
): Promise<{ days: string[]; types: TypeCounts[]; totals: number[] }> {
  const day = sql<string>`to_char(${events.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
  const rows = await database
    .select({ type: events.type, day, n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(...conditions(filters)))
    .groupBy(events.type, day)
  const days = rangeDays(filters.range)
  const index = new Map(days.map((d, i) => [d, i]))
  const byType = new Map<string, TypeCounts>()
  const totals = days.map(() => 0)
  for (const row of rows) {
    const at = index.get(row.day)
    if (at === undefined) continue
    let entry = byType.get(row.type)
    if (!entry) {
      entry = { type: row.type, total: 0, daily: days.map(() => 0) }
      byType.set(row.type, entry)
    }
    const n = Number(row.n)
    entry.daily[at] = (entry.daily[at] ?? 0) + n
    entry.total += n
    totals[at] = (totals[at] ?? 0) + n
  }
  const types = [...byType.values()].sort(
    (a, b) => b.total - a.total || a.type.localeCompare(b.type),
  )
  return { days, types, totals }
}

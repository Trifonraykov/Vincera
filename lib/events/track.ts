import "server-only"

import { z } from "zod"

import { now } from "@/lib/clock"
import { getDb, type DbOrTx } from "@/lib/db/client"
import { events } from "@/lib/db/schema"
import { newId } from "@/lib/ids"

import { EventPiiError, findPii, scrubPii } from "./pii"
import {
  isEventType,
  isSubjectType,
  type AnyTrackEvent,
  type EventType,
  type TrackInput,
} from "./types"

/**
 * Write business events (§11) to the append-only `events` table.
 *
 * Pass the transaction that makes the state change (`track(..., tx)`) so the event commits or
 * rolls back with it. Without one, the app's database is used.
 *
 * Properties are checked for keys/values that look like PII or secrets: outside production a hit
 * throws `EventPiiError` (so tests and development catch it); in production the offending fields
 * are dropped and the problem is logged, because analytics must never break a business write.
 */

const propertiesSchema = z.record(z.string(), z.json())

const contextSchema = z
  .object({
    ip_country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullish(),
    ua_hash: z.string().max(128).nullish(),
    session_id: z.string().max(128).nullish(),
  })
  .strict()

const uuidSchema = z.uuid()

type EventRow = typeof events.$inferInsert & { id: string }

/** Same rule as lib/env.ts (`APP_ENV`, defaulting from `NODE_ENV`), without parsing the env. */
function isProductionRuntime(): boolean {
  const appEnv = process.env.APP_ENV?.trim()
  return appEnv ? appEnv === "production" : process.env.NODE_ENV === "production"
}

function toRow<T extends EventType>(type: T, input: TrackInput<T>, occurredAt: Date): EventRow {
  const { subjectType, subjectId } = input
  if (!isEventType(type)) throw new Error(`Unknown event type "${type}"`)
  if (!isSubjectType(subjectType)) throw new Error(`Unknown subject type "${subjectType}"`)
  if (!uuidSchema.safeParse(subjectId).success) {
    throw new Error(`Event "${type}": subjectId must be a UUID`)
  }

  let properties: unknown = input.properties
  const findings = findPii(properties)
  if (findings.length > 0) {
    if (!isProductionRuntime()) throw new EventPiiError(type, findings)
    console.error(new EventPiiError(type, findings).message)
    properties = scrubPii(properties)
  }

  return {
    id: newId(),
    type,
    occurredAt: input.occurredAt ?? occurredAt,
    actorUserId: input.actorUserId ?? null,
    subjectType,
    subjectId,
    properties: propertiesSchema.parse(properties),
    context: contextSchema.parse(input.context ?? {}),
  }
}

async function insertRows(rows: EventRow[], database: DbOrTx | undefined): Promise<string[]> {
  if (rows.length > 0) await (database ?? getDb()).insert(events).values(rows)
  return rows.map((row) => row.id)
}

/** Record one event; returns its id. */
export async function track<T extends EventType>(
  type: T,
  input: TrackInput<T>,
  database?: DbOrTx,
): Promise<string> {
  const row = toRow(type, input, now())
  await insertRows([row], database)
  return row.id
}

/** Record several events in one insert (e.g. `match.shown` for a page of matches); returns ids. */
export async function trackMany(
  batch: readonly AnyTrackEvent[],
  database?: DbOrTx,
): Promise<string[]> {
  const occurredAt = now()
  return insertRows(
    batch.map((event) => toRow(event.type, event, occurredAt)),
    database,
  )
}

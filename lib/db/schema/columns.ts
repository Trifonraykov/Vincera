import { sql, type SQL } from "drizzle-orm"
import { text, timestamp, uuid, vector, type AnyPgColumn } from "drizzle-orm/pg-core"

// Relative imports: drizzle-kit loads this folder without the `@/` path alias.
import { now } from "../../clock"
import { newId } from "../../ids"
import { HANDLE_PATTERN } from "../../profiles/handle-format"

/**
 * Column helpers shared by every table (§4, §5).
 *
 * Timestamps are `timestamptz`. The app supplies created_at/updated_at from `now()` in lib/clock.ts,
 * so mocked clocks (tests, e2e jobs) also apply to row timestamps; the SQL `DEFAULT now()` covers
 * rows inserted with raw SQL.
 */

/** Dimensions of every `embedding` column (§2: 1024-dim vectors). */
export const EMBEDDING_DIMENSIONS = 1024

/** Handles: lowercase, 3–30 of [a-z0-9_] (§4). Enforced by CHECK constraints too. */
export { HANDLE_PATTERN, HANDLE_REGEX } from "../../profiles/handle-format"

/** Default currency for money columns (ISO 4217, lowercase like Stripe). */
export const DEFAULT_CURRENCY = "eur"

/** UUIDv7 primary key generated in the app (§4). */
export const id = () => uuid("id").primaryKey().$defaultFn(newId)

/** `timestamptz` column read and written as a JS Date. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

export const createdAt = () => timestamptz("created_at").notNull().defaultNow().$defaultFn(now)

export const updatedAt = () =>
  timestamptz("updated_at").notNull().defaultNow().$defaultFn(now).$onUpdate(now)

/** created_at + updated_at for mutable tables. Append-only tables use `createdAt()` alone. */
export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() })

/** `text[] NOT NULL DEFAULT '{}'`, typed as `T[]`. */
export const textArray = <T extends string = string>(name: string) =>
  text(name)
    .array()
    .notNull()
    .default(sql`'{}'::text[]`)
    .$type<T[]>()

/** Lowercase ISO 4217 currency code, default `eur`. */
export const currency = () => text("currency").notNull().default(DEFAULT_CURRENCY)

/** Nullable 1024-dim pgvector column (HNSW-indexed by each table). */
export const embedding = () => vector("embedding", { dimensions: EMBEDDING_DIMENSIONS })

/** Name of the embedding model that produced `embedding`, so a provider switch can re-embed. */
export const embeddingModel = () => text("embedding_model")

/** `<column> ~ '^[a-z0-9_]{3,30}$'`, for CHECK constraints. */
export function handleFormatCheck(column: AnyPgColumn): SQL {
  return sql`${column} ~ ${sql.raw(`'${HANDLE_PATTERN}'`)}`
}

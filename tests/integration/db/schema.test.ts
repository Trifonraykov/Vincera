import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { APPEND_ONLY_TABLES } from "@/lib/db/append-only"

import { setupTestDatabase } from "../../helpers/db"

const testDb = setupTestDatabase()

async function rows<T extends Record<string, unknown>>(query: ReturnType<typeof sql>) {
  const result = await testDb.db.execute<T>(query)
  return result.rows
}

describe("database structure", () => {
  it("has the pgvector extension and the v0 matching config", async () => {
    const ext = await rows<{ extname: string }>(
      sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    )
    expect(ext).toHaveLength(1)

    const config = await rows<{ model_version: string; active: boolean }>(
      sql`SELECT model_version, active FROM matching_config`,
    )
    expect(config).toEqual([{ model_version: "v0", active: true }])
  })

  it("has an HNSW cosine index on every embedding column", async () => {
    const vectorColumns = await rows<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND udt_name = 'vector' ORDER BY table_name`)
    const hnswIndexes = await rows<{ tablename: string; indexdef: string }>(sql`
      SELECT tablename, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef LIKE '%USING hnsw%' ORDER BY tablename`)

    const tables = vectorColumns.map((c) => c.table_name)
    expect(tables).toEqual(["builder_profiles", "creator_profiles", "ideas", "products"])
    expect(hnswIndexes.map((i) => i.tablename)).toEqual(tables)
    for (const index of hnswIndexes) expect(index.indexdef).toContain("embedding vector_cosine_ops")
  })

  it("indexes every foreign key", async () => {
    const foreignKeys = await rows<{ table: string; name: string; columns: number[] }>(sql`
      SELECT conrelid::regclass::text AS table, conname AS name, conkey AS columns
      FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`)
    const indexes = await rows<{ table: string; columns: string }>(sql`
      SELECT indrelid::regclass::text AS table, indkey::text AS columns FROM pg_index
      WHERE indrelid::regclass::text NOT LIKE 'drizzle.%'`)

    const indexColumns = indexes.map((i) => ({
      table: i.table,
      columns: i.columns.split(" ").map(Number),
    }))
    // An index supports a FK when its leading columns are FK columns, e.g. (user_id, created_at)
    // for user_id, or the unique (handle) index for the composite (handle, user_id) FK.
    const unindexed = foreignKeys.filter(
      (fk) =>
        !indexColumns.some(
          (index) =>
            index.table === fk.table &&
            index.columns
              .slice(0, Math.min(fk.columns.length, index.columns.length))
              .every((column) => fk.columns.includes(column)),
        ),
    )
    expect(unindexed.map((fk) => `${fk.table}.${fk.name}`)).toEqual([])
  })

  it("gives updated_at to every table except append-only, auth and log tables", async () => {
    const tables = await rows<{
      table_name: string
      has_created: boolean
      has_updated: boolean
    }>(sql`
      SELECT t.table_name,
        EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                  AND c.column_name = 'created_at' AND c.data_type = 'timestamp with time zone') AS has_created,
        EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                  AND c.column_name = 'updated_at' AND c.data_type = 'timestamp with time zone') AS has_updated
      FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name`)

    const withoutUpdatedAt = tables.filter((t) => !t.has_updated).map((t) => t.table_name)
    expect(withoutUpdatedAt.sort()).toEqual(
      [...APPEND_ONLY_TABLES, "handles", "sessions", "verification_tokens", "stripe_events"].sort(),
    )
    // events has occurred_at; the Auth.js session/token tables and stripe_events have their own.
    const withoutCreatedAt = tables.filter((t) => !t.has_created).map((t) => t.table_name)
    expect(withoutCreatedAt.sort()).toEqual(
      ["events", "sessions", "stripe_events", "verification_tokens"].sort(),
    )
  })

  it("installs the append-only triggers", async () => {
    const triggers = await rows<{ table: string; name: string }>(sql`
      SELECT tgrelid::regclass::text AS table, tgname AS name FROM pg_trigger
      WHERE NOT tgisinternal ORDER BY 1, 2`)
    for (const table of APPEND_ONLY_TABLES) {
      expect(triggers).toContainEqual({ table, name: `${table}_append_only` })
      expect(triggers).toContainEqual({ table, name: `${table}_no_truncate` })
    }
  })
})

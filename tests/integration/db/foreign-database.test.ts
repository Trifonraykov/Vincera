import { readMigrationFiles } from "drizzle-orm/migrator"
import { Client } from "pg"
import { afterAll, describe, expect, it } from "vitest"

import { foreignObjects } from "@/lib/db/supabase-hardening"
import {
  ALLOW_FOREIGN_OBJECTS,
  DEFAULT_MIGRATIONS_FOLDER,
  ForeignDatabaseError,
  runMigrations,
} from "@/scripts/lib/db-admin"

import { createEmptyTestDatabase, dropEmptyTestDatabase, setupTestDatabase } from "../../helpers/db"

/**
 * `pnpm db:migrate` only migrates (and hardens, lib/db/supabase-hardening.ts) the platform's own
 * database: one holding another app's objects is refused untouched unless
 * DATABASE_ALLOW_FOREIGN_OBJECTS=1 (CLAUDE.md §19.23). Each test makes its own empty database.
 */

const testDb = setupTestDatabase()
const hashes = readMigrationFiles({ migrationsFolder: DEFAULT_MIGRATIONS_FOLDER }).map(
  (migration) => migration.hash,
)
const created: { name: string }[] = []
const clients: Client[] = []

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.end().catch(() => undefined)))
  for (const database of created.splice(0)) await dropEmptyTestDatabase(database)
})

async function emptyDatabase(): Promise<{ url: string; client: Client }> {
  const database = await createEmptyTestDatabase()
  created.push(database)
  const client = new Client({ connectionString: database.url })
  clients.push(client)
  await client.connect()
  return { url: database.url, client }
}

async function exists(client: Client, relation: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [relation],
  )
  return rows[0]?.exists ?? false
}

describe("foreignObjects", () => {
  it("knows the platform's own database by its migrations journal", async () => {
    const client = new Client({ connectionString: testDb.url })
    clients.push(client)
    await client.connect()
    expect(await foreignObjects(client, hashes)).toEqual({ platform: true, objects: [] })
  })

  it("finds nothing in an empty database, extensions included (a fresh Supabase project)", async () => {
    const { client } = await emptyDatabase()
    await client.query("CREATE EXTENSION IF NOT EXISTS vector")
    expect(await foreignObjects(client, hashes)).toEqual({ platform: false, objects: [] })
  })
})

describe("runMigrations on a database that is not the platform's", () => {
  it("refuses another app's tables, views and functions untouched, unless allowed", async () => {
    const { url, client } = await emptyDatabase()
    await client.query("CREATE TABLE public.todos (id serial PRIMARY KEY, title text)")
    await client.query("CREATE VIEW public.open_todos AS SELECT * FROM public.todos")
    await client.query(
      "CREATE FUNCTION public.list_todos() RETURNS SETOF public.todos LANGUAGE sql AS 'SELECT * FROM public.todos'",
    )
    // The serial's sequence is listed with its table, not on its own.
    expect(await foreignObjects(client, hashes)).toEqual({
      platform: false,
      objects: ["public.list_todos()", "public.open_todos", "public.todos"],
    })

    const error = await runMigrations(url).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ForeignDatabaseError)
    expect(String(error)).toMatch(/public\.list_todos\(\), public\.open_todos, public\.todos/)
    expect(String(error)).toContain(`${ALLOW_FOREIGN_OBJECTS}=1`)
    // Nothing changed: no journal, no pgvector, and the app's table keeps its settings.
    expect(await exists(client, "drizzle.__drizzle_migrations")).toBe(false)
    const vector = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
    expect(vector.rowCount).toBe(0)

    // Allowed on purpose: migrated, and from then on it is the platform's database.
    const log: string[] = []
    await runMigrations(url, undefined, {
      allowForeignObjects: true,
      log: (line) => log.push(line),
    })
    expect(log.join("\n")).toMatch(/DATABASE_ALLOW_FOREIGN_OBJECTS=1: migrating .*\(3\)/)
    expect(await exists(client, "public.users")).toBe(true)
    expect(await foreignObjects(client, hashes)).toEqual({ platform: true, objects: [] })
    await expect(runMigrations(url)).resolves.toMatchObject({ vector: { status: "ok" } })
  })

  it("refuses another Drizzle app's migrations journal", async () => {
    const { url, client } = await emptyDatabase()
    await client.query("CREATE SCHEMA drizzle")
    await client.query(
      "CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    )
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('not-ours', 1)",
    )
    expect(await foreignObjects(client, hashes)).toEqual({
      platform: false,
      objects: ["drizzle.__drizzle_migrations (1 migration of another app)"],
    })
    await expect(runMigrations(url)).rejects.toBeInstanceOf(ForeignDatabaseError)
  })

  it("migrates an empty database without asking", async () => {
    const { url, client } = await emptyDatabase()
    await runMigrations(url)
    expect(await exists(client, "public.users")).toBe(true)
  })
})

import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, expect, inject } from "vitest"

import { createDb, type Db, type DbHandle } from "@/lib/db/client"
import { getPgError, type PgErrorCode } from "@/lib/db/errors"

import { cloneDatabase, databaseUrl, dropDatabases } from "./db-template"

/**
 * Per-file test databases for integration tests (CLAUDE.md §19.4).
 *
 * Each test file gets its own database, cloned from the migrated template that
 * tests/integration/global-setup.ts prepared, so files run in parallel without sharing state:
 *
 *   const testDb = setupTestDatabase()
 *   it("...", async () => { await testDb.db.insert(users).values(...) })
 *
 * Code under test receives `testDb.db` (or a transaction) as its `DbOrTx` argument; nothing global
 * is mutated.
 */

export type TestDatabase = DbHandle & {
  name: string
  url: string
}

function testDatabaseConfig() {
  const config = inject("testDatabase")
  if (!config) {
    throw new Error(
      "No test database template: run integration tests through the Vitest `integration` project.",
    )
  }
  return config
}

/** Clone the template into a fresh database for the calling file. Pair with `dropTestDatabase`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const { adminUrl, template, runPrefix } = testDatabaseConfig()
  const name = `${runPrefix}_${randomBytes(4).toString("hex")}`
  await cloneDatabase(adminUrl, template, name)
  const url = databaseUrl(adminUrl, name)
  return { ...createDb(url, { max: 4 }), name, url }
}

/** Close the database's pool and drop it. */
export async function dropTestDatabase(database: TestDatabase): Promise<void> {
  await database.close()
  await dropDatabases(testDatabaseConfig().adminUrl, [database.name])
}

/**
 * Register beforeAll/afterAll hooks that create this file's database and drop it afterwards.
 * Read `.db` / `.url` inside tests or hooks (they throw before the database exists).
 */
export function setupTestDatabase(): { readonly db: Db; readonly url: string } {
  let database: TestDatabase | undefined

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    if (database) await dropTestDatabase(database)
    database = undefined
  })

  const current = (): TestDatabase => {
    if (!database) throw new Error("The test database is only available inside tests and hooks.")
    return database
  }

  return {
    get db() {
      return current().db
    },
    get url() {
      return current().url
    },
  }
}

/**
 * Assert that a query fails with Postgres error `code` (and `constraint`, when given).
 * Drizzle queries are lazy thenables, so pass the query itself: `expectPgError(db.insert(...), ...)`.
 */
export async function expectPgError(
  query: PromiseLike<unknown>,
  code: PgErrorCode,
  constraint?: string,
): Promise<void> {
  const error = await Promise.resolve(query).then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error, "expected the query to fail").not.toBeNull()
  const pgError = getPgError(error)
  expect(pgError?.code, String(error)).toBe(code)
  if (constraint !== undefined) expect(pgError?.constraint).toBe(constraint)
}

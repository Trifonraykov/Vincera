import { count, eq, is } from "drizzle-orm"
import { PgDatabase } from "drizzle-orm/pg-core"
import { afterAll, describe, expect, it, vi } from "vitest"

import { closeDb, db, getDb, isTransaction, withTransaction } from "@/lib/db/client"
import { getPgError, PG_ERROR } from "@/lib/db/errors"
import { users } from "@/lib/db/schema"
import { resetEnvCache } from "@/lib/env"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"

const testDb = setupTestDatabase()

async function userCount(email: string): Promise<number> {
  const [row] = await testDb.db.select({ n: count() }).from(users).where(eq(users.email, email))
  return row?.n ?? 0
}

describe("withTransaction", () => {
  it("commits on success and rolls back on error", async () => {
    await withTransaction(async (tx) => {
      expect(isTransaction(tx)).toBe(true)
      await insertUser(tx, { email: "committed@example.test" })
    }, testDb.db)
    expect(await userCount("committed@example.test")).toBe(1)

    await expect(
      withTransaction(async (tx) => {
        await insertUser(tx, { email: "rolled-back@example.test" })
        throw new Error("boom")
      }, testDb.db),
    ).rejects.toThrow("boom")
    expect(await userCount("rolled-back@example.test")).toBe(0)
  })

  it("nests as a savepoint when given a transaction", async () => {
    await withTransaction(async (tx) => {
      await insertUser(tx, { email: "outer@example.test" })
      await withTransaction(async (inner) => {
        await insertUser(inner, { email: "inner@example.test" })
        throw new Error("inner failed")
      }, tx).catch(() => {})
    }, testDb.db)
    expect(await userCount("outer@example.test")).toBe(1)
    expect(await userCount("inner@example.test")).toBe(0)
  })
})

describe("getPgError", () => {
  it("unwraps drizzle's query error to the Postgres error", async () => {
    await insertUser(testDb.db, { email: "dup@example.test" })
    const error = await insertUser(testDb.db, { email: "dup@example.test" }).catch(
      (reason: unknown) => reason,
    )
    expect(getPgError(error)).toMatchObject({
      code: PG_ERROR.uniqueViolation,
      constraint: "users_email_unique",
    })
  })
})

describe("app singleton", () => {
  afterAll(async () => {
    await closeDb()
    resetEnvCache()
  })

  it("connects lazily to DATABASE_URL and behaves like a drizzle database", async () => {
    vi.stubEnv("DATABASE_URL", testDb.url)
    vi.stubEnv("AUTH_SECRET", "x".repeat(32))
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"))
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    vi.stubEnv("APP_ENV", "test")
    resetEnvCache()
    await closeDb()

    expect(is(db, PgDatabase)).toBe(true)
    expect(getDb()).toBe(getDb())
    const user = await insertUser(db, { email: "singleton@example.test" })
    const [found] = await db.select().from(users).where(eq(users.id, user.id))
    expect(found?.email).toBe("singleton@example.test")
    expect(await db.query.users.findFirst({ where: eq(users.id, user.id) })).toMatchObject({
      id: user.id,
    })
  })
})

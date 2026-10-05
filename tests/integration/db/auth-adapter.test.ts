import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { accounts, sessions, users, verificationTokens } from "@/lib/db/schema"

import { setupTestDatabase } from "../../helpers/db"

const testDb = setupTestDatabase()

/** The schema must satisfy @auth/drizzle-adapter's table contract (types and behaviour). */
function adapter() {
  return DrizzleAdapter(testDb.db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  })
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("Auth.js Drizzle adapter on our schema", () => {
  it("creates users with our UUIDv7 ids and maps image to avatar_url", async () => {
    const auth = adapter()
    if (!auth.createUser || !auth.getUserByEmail || !auth.updateUser) throw new Error("adapter")

    const created = await auth.createUser({
      id: crypto.randomUUID(),
      email: "magic@example.test",
      emailVerified: null,
      name: "Magic Link",
      image: "https://example.test/avatar.png",
    })
    expect(created.id).toMatch(UUID_V7)
    expect(created.image).toBe("https://example.test/avatar.png")

    const row = await testDb.db.execute<{ avatar_url: string; roles: string[]; status: string }>(
      sql`SELECT avatar_url, roles, status FROM users WHERE id = ${created.id}`,
    )
    expect(row.rows[0]).toEqual({
      avatar_url: "https://example.test/avatar.png",
      roles: [],
      status: "active",
    })

    expect((await auth.getUserByEmail("magic@example.test"))?.id).toBe(created.id)
    const verifiedAt = new Date("2026-01-01T00:00:00.000Z")
    const updated = await auth.updateUser({ id: created.id, emailVerified: verifiedAt })
    expect(updated.emailVerified?.toISOString()).toBe(verifiedAt.toISOString())
  })

  it("links OAuth accounts and manages database sessions", async () => {
    const auth = adapter()
    if (
      !auth.createUser ||
      !auth.linkAccount ||
      !auth.getUserByAccount ||
      !auth.createSession ||
      !auth.getSessionAndUser ||
      !auth.updateSession ||
      !auth.deleteSession ||
      !auth.unlinkAccount
    ) {
      throw new Error("adapter is missing methods")
    }
    const user = await auth.createUser({
      id: crypto.randomUUID(),
      email: "oauth@example.test",
      emailVerified: null,
    })

    await auth.linkAccount({
      userId: user.id,
      type: "oauth",
      provider: "github",
      providerAccountId: "12345",
      access_token: "gho_test",
      token_type: "bearer",
      scope: "read:user user:email",
    })
    expect(
      (await auth.getUserByAccount({ provider: "github", providerAccountId: "12345" }))?.id,
    ).toBe(user.id)

    const expires = new Date("2030-01-01T00:00:00.000Z")
    await auth.createSession({ sessionToken: "session-token-1", userId: user.id, expires })
    const found = await auth.getSessionAndUser("session-token-1")
    expect(found?.user.id).toBe(user.id)
    expect(found?.session.expires.toISOString()).toBe(expires.toISOString())

    const extended = new Date("2030-02-01T00:00:00.000Z")
    await auth.updateSession({ sessionToken: "session-token-1", expires: extended })
    expect((await auth.getSessionAndUser("session-token-1"))?.session.expires.toISOString()).toBe(
      extended.toISOString(),
    )
    await auth.deleteSession("session-token-1")
    expect(await auth.getSessionAndUser("session-token-1")).toBeNull()

    await auth.unlinkAccount({ provider: "github", providerAccountId: "12345" })
    expect(await testDb.db.select().from(accounts).where(eq(accounts.userId, user.id))).toEqual([])
  })

  it("stores and consumes magic-link verification tokens once", async () => {
    const auth = adapter()
    if (!auth.createVerificationToken || !auth.useVerificationToken) throw new Error("adapter")
    const expires = new Date("2030-01-01T00:00:00.000Z")
    await auth.createVerificationToken({ identifier: "who@example.test", token: "hashed", expires })

    const used = await auth.useVerificationToken({
      identifier: "who@example.test",
      token: "hashed",
    })
    expect(used?.expires.toISOString()).toBe(expires.toISOString())
    expect(
      await auth.useVerificationToken({ identifier: "who@example.test", token: "hashed" }),
    ).toBeNull()
  })
})

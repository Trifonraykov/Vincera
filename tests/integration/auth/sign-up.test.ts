import { and, eq } from "drizzle-orm"
import type { AdapterUser } from "next-auth/adapters"
import { describe, expect, it } from "vitest"

import { createAuthAdapter } from "@/lib/auth/adapter"
import { registerUser } from "@/lib/auth/register"
import { isSuspendedSignIn } from "@/lib/auth/suspension"
import { accounts, adminAuditLog, events, users } from "@/lib/db/schema"
import { addUserRoles, grantAdminRole, setActiveRole } from "@/lib/users/roles"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"

const testDb = setupTestDatabase()

const ADMIN_EMAILS = ["boss@example.test"]

async function eventsFor(userId: string) {
  return testDb.db
    .select({ type: events.type, actorUserId: events.actorUserId, properties: events.properties })
    .from(events)
    .where(eq(events.subjectId, userId))
    .orderBy(events.occurredAt, events.id)
}

describe("registerUser (adapter createUser)", () => {
  it("creates the user and emits user.signed_up with the method, in one transaction", async () => {
    const user = await registerUser(
      testDb.db,
      { email: "  New.Person@Example.TEST ", name: " New Person ", emailVerified: null },
      { method: "github", adminEmails: ADMIN_EMAILS },
    )

    expect(user).toMatchObject({
      email: "new.person@example.test",
      name: "New Person",
      roles: [],
      activeRole: null,
      status: "active",
    })
    expect(await eventsFor(user.id)).toEqual([
      { type: "user.signed_up", actorUserId: user.id, properties: { method: "github" } },
    ])
  })

  it("grants the admin role to ADMIN_EMAILS (case-insensitive), with event and audit log", async () => {
    const user = await registerUser(
      testDb.db,
      { email: "Boss@Example.test" },
      { method: "email", adminEmails: ADMIN_EMAILS },
    )

    expect(user.roles).toEqual(["admin"])
    expect(await eventsFor(user.id)).toEqual([
      { type: "user.signed_up", actorUserId: user.id, properties: { method: "email" } },
      {
        type: "user.role_added",
        actorUserId: null,
        properties: { role: "admin", source: "admin_emails" },
      },
    ])
    const audit = await testDb.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.targetId, user.id))
    expect(audit).toEqual([
      expect.objectContaining({
        adminUserId: user.id,
        action: "user.role_granted",
        targetType: "user",
        before: { roles: [] },
        after: { roles: ["admin"], role: "admin", source: "admin_emails" },
      }),
    ])
  })

  it("rolls the user back when the sign-up cannot be completed", async () => {
    await insertUser(testDb.db, { email: "taken@example.test" })
    await expect(
      registerUser(
        testDb.db,
        { email: "TAKEN@example.test" },
        { method: "email", adminEmails: [] },
      ),
    ).rejects.toThrow()
    const rows = await testDb.db.select().from(users).where(eq(users.email, "taken@example.test"))
    expect(rows).toHaveLength(1)
  })
})

describe("createAuthAdapter", () => {
  function adapter(pendingName: string | null = null) {
    return createAuthAdapter(testDb.db, {
      method: "google",
      adminEmails: ADMIN_EMAILS,
      pendingName,
    })
  }

  it("createUser uses the pending /sign-up name when the provider gives none", async () => {
    const { createUser } = adapter("Ada Lovelace")
    if (!createUser) throw new Error("adapter.createUser missing")
    const data: AdapterUser = {
      id: crypto.randomUUID(),
      email: "ada@example.test",
      emailVerified: new Date("2026-01-01T00:00:00Z"),
    }
    const created = await createUser(data)

    expect(created.id).not.toBe(data.id)
    expect(created).toMatchObject({ email: "ada@example.test", name: "Ada Lovelace" })
    expect(await eventsFor(created.id)).toEqual([
      expect.objectContaining({ type: "user.signed_up", properties: { method: "google" } }),
    ])
  })

  it("prefers the provider's name over the pending name", async () => {
    const { createUser } = adapter("Typed Name")
    if (!createUser) throw new Error("adapter.createUser missing")
    const created = await createUser({
      id: "provider-id",
      email: "named@example.test",
      emailVerified: null,
      name: "Provider Name",
      image: "https://example.test/a.png",
    })
    expect(created).toMatchObject({ name: "Provider Name", image: "https://example.test/a.png" })
  })

  it("getUserByEmail matches regardless of case and spacing", async () => {
    const user = await insertUser(testDb.db, { email: "mixed@example.test" })
    const { getUserByEmail } = adapter()
    if (!getUserByEmail) throw new Error("adapter.getUserByEmail missing")
    expect((await getUserByEmail(" Mixed@Example.TEST"))?.id).toBe(user.id)
  })

  it("linkAccount stores the login account without OAuth tokens", async () => {
    const user = await insertUser(testDb.db)
    const { linkAccount } = adapter()
    if (!linkAccount) throw new Error("adapter.linkAccount missing")
    await linkAccount({
      userId: user.id,
      type: "oauth",
      provider: "github",
      providerAccountId: "gh-42",
      access_token: "gho_secret",
      refresh_token: "ghr_secret",
      id_token: "id.token.secret",
      token_type: "bearer",
      scope: "read:user user:email",
      session_state: "state",
    })

    const [row] = await testDb.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, "github"), eq(accounts.providerAccountId, "gh-42")))
    expect(row).toMatchObject({
      userId: user.id,
      access_token: null,
      refresh_token: null,
      id_token: null,
      session_state: null,
      token_type: "bearer",
      scope: "read:user user:email",
    })
  })
})

describe("isSuspendedSignIn", () => {
  it("finds suspended accounts by id or normalised email", async () => {
    const suspended = await insertUser(testDb.db, {
      email: "banned@example.test",
      status: "suspended",
    })
    const active = await insertUser(testDb.db, { email: "fine@example.test" })

    expect(await isSuspendedSignIn(testDb.db, { id: suspended.id })).toBe(true)
    expect(await isSuspendedSignIn(testDb.db, { email: " BANNED@example.test" })).toBe(true)
    // OAuth placeholders carry the provider's id, which is not a UUID.
    expect(await isSuspendedSignIn(testDb.db, { id: "12345", email: "banned@example.test" })).toBe(
      true,
    )
    expect(await isSuspendedSignIn(testDb.db, { id: active.id, email: active.email })).toBe(false)
    expect(
      await isSuspendedSignIn(testDb.db, { id: crypto.randomUUID(), email: "new@x.test" }),
    ).toBe(false)
    expect(await isSuspendedSignIn(testDb.db, {})).toBe(false)
  })
})

describe("role changes", () => {
  it("addUserRoles adds roles, sets the active role and emits one event per new role", async () => {
    const user = await insertUser(testDb.db)
    const first = await addUserRoles(testDb.db, {
      userId: user.id,
      roles: ["builder"],
      source: "onboarding",
      actorUserId: user.id,
      activeRole: "builder",
    })
    expect(first).toEqual({ roles: ["builder"], added: ["builder"], activeRole: "builder" })

    const second = await addUserRoles(testDb.db, {
      userId: user.id,
      roles: ["creator", "builder"],
      source: "onboarding",
      actorUserId: user.id,
    })
    expect(second).toEqual({
      roles: ["creator", "builder"],
      added: ["creator"],
      activeRole: "builder",
    })

    expect(await eventsFor(user.id)).toEqual([
      expect.objectContaining({ properties: { role: "builder", source: "onboarding" } }),
      expect.objectContaining({ properties: { role: "creator", source: "onboarding" } }),
    ])
  })

  it("rejects an active role the user does not have", async () => {
    const user = await insertUser(testDb.db)
    await expect(
      addUserRoles(testDb.db, {
        userId: user.id,
        roles: ["creator"],
        source: "onboarding",
        actorUserId: user.id,
        activeRole: "builder",
      }),
    ).rejects.toThrow(/not one of the user's roles/)
    expect(await eventsFor(user.id)).toEqual([])
  })

  it("setActiveRole only switches to a role the user has", async () => {
    const user = await insertUser(testDb.db, { roles: ["creator"], activeRole: "creator" })
    expect(await setActiveRole(testDb.db, { userId: user.id, role: "builder" })).toBe(false)
    await addUserRoles(testDb.db, {
      userId: user.id,
      roles: ["builder"],
      source: "onboarding",
      actorUserId: user.id,
    })
    expect(await setActiveRole(testDb.db, { userId: user.id, role: "builder" })).toBe(true)
    const [row] = await testDb.db.select().from(users).where(eq(users.id, user.id))
    expect(row?.activeRole).toBe("builder")
  })

  it("grantAdminRole is audited and idempotent", async () => {
    const user = await insertUser(testDb.db, { roles: ["creator"], activeRole: "creator" })
    expect(await grantAdminRole(testDb.db, { userId: user.id, source: "admin_cli" })).toBe(true)
    expect(await grantAdminRole(testDb.db, { userId: user.id, source: "admin_cli" })).toBe(false)

    const [row] = await testDb.db.select().from(users).where(eq(users.id, user.id))
    expect(row).toMatchObject({ roles: ["creator", "admin"], activeRole: "creator" })
    const audit = await testDb.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.targetId, user.id))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.after).toEqual({
      roles: ["creator", "admin"],
      role: "admin",
      source: "admin_cli",
    })
  })
})

import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { adminAuditActionLabel, AuditSnapshotPiiError, writeAdminAudit } from "@/lib/admin/audit"
import { loadActiveImpersonation } from "@/lib/auth/impersonation"
import { parseAuthUser } from "@/lib/auth/user"
import { adminAuditLog, impersonationSessions, users } from "@/lib/db/schema"

import { setupTestDatabase } from "../../helpers/db"
import { insertImpersonationSession, insertUser } from "../../helpers/db-fixtures"

/** Shared pieces the W4 prep wrote for the Phase 6–7 builders (CLAUDE.md §19.38). */

const testDb = setupTestDatabase()
const T = new Date("2026-10-06T10:00:00.000Z")
const MINUTE = 60 * 1000

async function people() {
  const adminRow = await insertUser(testDb.db, {
    roles: ["admin"],
    onboardingCompletedAt: T,
  })
  const targetRow = await insertUser(testDb.db, {
    roles: ["creator"],
    activeRole: "creator",
    onboardingCompletedAt: T,
  })
  const admin = parseAuthUser(adminRow)
  if (!admin) throw new Error("admin did not parse")
  return { admin, adminRow, targetRow }
}

describe("loadActiveImpersonation", () => {
  it("returns the target for the admin of an open, unexpired session", async () => {
    const { admin, targetRow } = await people()
    const session = await insertImpersonationSession(testDb.db, {
      adminUserId: admin.id,
      targetUserId: targetRow.id,
      startedAt: T,
    })
    const claim = {
      sessionId: session.id,
      adminUserId: admin.id,
      targetUserId: targetRow.id,
      expiresAt: session.expiresAt,
    }
    const active = await loadActiveImpersonation(testDb.db, {
      realUser: admin,
      claim,
      at: new Date(T.getTime() + MINUTE),
    })
    expect(active?.target).toMatchObject({ id: targetRow.id, roles: ["creator"] })
    expect(active?.sessionId).toBe(session.id)

    // Expired, another admin's claim, or a stopped session: nothing.
    const later = new Date(T.getTime() + 61 * MINUTE)
    expect(await loadActiveImpersonation(testDb.db, { realUser: admin, claim, at: later })).toBe(
      null,
    )
    const other = parseAuthUser(await insertUser(testDb.db, { roles: ["admin"] }))
    if (!other) throw new Error("other admin did not parse")
    expect(await loadActiveImpersonation(testDb.db, { realUser: other, claim, at: T })).toBeNull()
    await testDb.db
      .update(impersonationSessions)
      .set({ endedAt: new Date(T.getTime() + MINUTE), endReason: "stopped" })
      .where(eq(impersonationSessions.id, session.id))
    expect(
      await loadActiveImpersonation(testDb.db, {
        realUser: admin,
        claim,
        at: new Date(T.getTime() + 2 * MINUTE),
      }),
    ).toBeNull()
  })

  it("never shows an admin, a suspended or a deleted account", async () => {
    const { admin, targetRow } = await people()
    const session = await insertImpersonationSession(testDb.db, {
      adminUserId: admin.id,
      targetUserId: targetRow.id,
      startedAt: T,
    })
    const claim = {
      sessionId: session.id,
      adminUserId: admin.id,
      targetUserId: targetRow.id,
      expiresAt: session.expiresAt,
    }
    const at = new Date(T.getTime() + MINUTE)
    await testDb.db.update(users).set({ status: "suspended" }).where(eq(users.id, targetRow.id))
    expect(await loadActiveImpersonation(testDb.db, { realUser: admin, claim, at })).toBeNull()
    await testDb.db
      .update(users)
      .set({ status: "active", roles: ["creator", "admin"] })
      .where(eq(users.id, targetRow.id))
    expect(await loadActiveImpersonation(testDb.db, { realUser: admin, claim, at })).toBeNull()
  })
})

describe("writeAdminAudit", () => {
  it("writes one row with before/after and refuses snapshots that look like personal data", async () => {
    const { admin, targetRow } = await people()
    const id = await writeAdminAudit(testDb.db, {
      adminUserId: admin.id,
      action: "user.suspended",
      targetType: "user",
      targetId: targetRow.id,
      before: { status: "active" },
      after: { status: "suspended" },
    })
    const [row] = await testDb.db.select().from(adminAuditLog).where(eq(adminAuditLog.id, id))
    expect(row).toMatchObject({
      action: "user.suspended",
      targetType: "user",
      before: { status: "active" },
      after: { status: "suspended" },
    })
    await expect(
      writeAdminAudit(testDb.db, {
        adminUserId: admin.id,
        action: "user.suspended",
        targetType: "user",
        targetId: targetRow.id,
        before: { email: "someone@example.com" },
        after: null,
      }),
    ).rejects.toBeInstanceOf(AuditSnapshotPiiError)
    expect(adminAuditActionLabel("ledger.adjusted")).toBe("Made a ledger adjustment")
    expect(adminAuditActionLabel("something.else")).toBe("something.else")
  })
})

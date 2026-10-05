import { eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"

import { allowGdprErasure } from "@/lib/db/append-only"
import { PG_ERROR } from "@/lib/db/errors"
import {
  adminAuditLog,
  agreementSignatures,
  agreements,
  audienceSnapshots,
  events,
  ledgerEntries,
  linkClicks,
  proposalRevisions,
  socialConnections,
  trackedLinks,
  transfers,
} from "@/lib/db/schema"

import { expectPgError, setupTestDatabase } from "../../helpers/db"
import { insertLiveLaunch, insertOrder, insertUser } from "../../helpers/db-fixtures"

const testDb = setupTestDatabase()
const AO = PG_ERROR.appendOnlyViolation

async function insertSnapshot(socialConnectionId: string) {
  const [snapshot] = await testDb.db
    .insert(audienceSnapshots)
    .values({ socialConnectionId, takenAt: new Date("2026-01-01T00:00:00Z"), followers: 1200 })
    .returning()
  if (!snapshot) throw new Error("no snapshot")
  return snapshot
}

describe("append-only tables", () => {
  let ids: {
    eventId: string
    snapshotId: string
    revisionId: string
    signatureId: string
    clickId: string
    auditId: string
  }

  beforeAll(async () => {
    const db = testDb.db
    const { creator, launch, proposal } = await insertLiveLaunch(db)

    const [event] = await db
      .insert(events)
      .values({ type: "user.signed_up", subjectType: "user", subjectId: creator.user.id })
      .returning()
    const [connection] = await db
      .insert(socialConnections)
      .values({ userId: creator.user.id, provider: "youtube", providerAccountId: "UC123" })
      .returning()
    const [revision] = await db
      .select()
      .from(proposalRevisions)
      .where(eq(proposalRevisions.proposalId, proposal.id))
    const [agreement] = await db
      .insert(agreements)
      .values({
        collabId: launch.collabId,
        templateVersion: "v1",
        terms: {
          parties: [],
          scope: "MVP",
          timelineWeeks: 4,
          ip: "joint",
          term: "1y",
          exit: "30d",
        },
        bodyHash: "a".repeat(64),
      })
      .returning()
    if (!event || !connection || !revision || !agreement) throw new Error("fixture setup failed")
    const [signature] = await db
      .insert(agreementSignatures)
      .values({
        agreementId: agreement.id,
        userId: creator.user.id,
        signedAt: new Date("2026-01-02T00:00:00Z"),
        ip: "203.0.113.7",
        typedName: "Creator Name",
      })
      .returning()
    const [link] = await db
      .insert(trackedLinks)
      .values({ launchId: launch.id, ownerUserId: creator.user.id, code: "Ab3dE5gH" })
      .returning()
    if (!signature || !link) throw new Error("fixture setup failed")
    const [click] = await db
      .insert(linkClicks)
      .values({ trackedLinkId: link.id, clickedAt: new Date("2026-01-03T00:00:00Z") })
      .returning()
    const [audit] = await db
      .insert(adminAuditLog)
      .values({ adminUserId: creator.user.id, action: "user.view", targetType: "user" })
      .returning()
    if (!click || !audit) throw new Error("fixture setup failed")
    const snapshot = await insertSnapshot(connection.id)

    ids = {
      eventId: event.id,
      snapshotId: snapshot.id,
      revisionId: revision.id,
      signatureId: signature.id,
      clickId: click.id,
      auditId: audit.id,
    }
  })

  const cases = [
    { table: "events", column: "type", value: "'changed'", id: () => ids.eventId },
    { table: "audience_snapshots", column: "followers", value: "1", id: () => ids.snapshotId },
    { table: "proposal_revisions", column: "scope", value: "'changed'", id: () => ids.revisionId },
    {
      table: "agreement_signatures",
      column: "typed_name",
      value: "'x'",
      id: () => ids.signatureId,
    },
    { table: "link_clicks", column: "referrer", value: "'x'", id: () => ids.clickId },
    { table: "admin_audit_log", column: "action", value: "'x'", id: () => ids.auditId },
  ] as const

  for (const { table, column, value, id } of cases) {
    it(`${table}: blocks UPDATE, DELETE and TRUNCATE`, async () => {
      const t = sql.identifier(table)
      await expectPgError(
        testDb.db.execute(
          sql`UPDATE ${t} SET ${sql.identifier(column)} = ${sql.raw(value)} WHERE id = ${id()}`,
        ),
        AO,
      )
      await expectPgError(testDb.db.execute(sql`DELETE FROM ${t} WHERE id = ${id()}`), AO)
      await expectPgError(testDb.db.execute(sql`TRUNCATE ${t} CASCADE`), AO)

      const remaining = await testDb.db.execute(sql`SELECT 1 FROM ${t} WHERE id = ${id()}`)
      expect(remaining.rows).toHaveLength(1)
    })
  }

  it("events: the error names the table and the operation", async () => {
    const error = await testDb.db
      .delete(events)
      .where(eq(events.id, ids.eventId))
      .then(
        () => null,
        (reason: unknown) => reason,
      )
    expect(String(error instanceof Error ? error.cause : error)).toMatch(
      /DELETE on "events" is not allowed: the table is append-only/,
    )
  })
})

describe("ledger_entries", () => {
  async function setup() {
    const db = testDb.db
    const { launch, creator } = await insertLiveLaunch(db)
    const paidAt = new Date("2026-01-01T00:00:00Z")
    const order = await insertOrder(db, launch.id, paidAt)
    const [entry] = await db
      .insert(ledgerEntries)
      .values({
        orderId: order.id,
        userId: creator.user.id,
        account: "creator_share",
        amountCents: 1000,
        availableAt: new Date("2026-01-15T00:00:00Z"),
      })
      .returning()
    const [transfer, otherTransfer] = await db
      .insert(transfers)
      .values([
        { userId: creator.user.id, amountCents: 1000 },
        { userId: creator.user.id, amountCents: 1000 },
      ])
      .returning()
    if (!entry || !transfer || !otherTransfer) throw new Error("fixture setup failed")
    return { entry, transfer, otherTransfer }
  }

  it("allows setting transfer_id once, from NULL, and nothing else", async () => {
    const db = testDb.db
    const { entry, transfer, otherTransfer } = await setup()
    const byId = eq(ledgerEntries.id, entry.id)

    // transfer_id together with another column: blocked.
    await expectPgError(
      db.update(ledgerEntries).set({ transferId: transfer.id, amountCents: 1 }).where(byId),
      AO,
    )
    await expectPgError(db.update(ledgerEntries).set({ amountCents: 999 }).where(byId), AO)

    const [paid] = await db
      .update(ledgerEntries)
      .set({ transferId: transfer.id })
      .where(byId)
      .returning()
    expect(paid?.transferId).toBe(transfer.id)

    // Once set, transfer_id is frozen too.
    await expectPgError(
      db.update(ledgerEntries).set({ transferId: otherTransfer.id }).where(byId),
      AO,
    )
    await expectPgError(db.update(ledgerEntries).set({ transferId: null }).where(byId), AO)
  })

  it("blocks DELETE and TRUNCATE", async () => {
    const { entry } = await setup()
    await expectPgError(testDb.db.delete(ledgerEntries).where(eq(ledgerEntries.id, entry.id)), AO)
    await expectPgError(testDb.db.execute(sql`TRUNCATE ledger_entries CASCADE`), AO)
  })

  it("enforces user ownership rules per account", async () => {
    const user = await insertUser(testDb.db)
    const availableAt = new Date("2026-01-15T00:00:00Z")
    await expectPgError(
      testDb.db
        .insert(ledgerEntries)
        .values({ account: "builder_share", amountCents: 100, availableAt }),
      PG_ERROR.checkViolation,
      "ledger_entries_share_has_user",
    )
    await expectPgError(
      testDb.db
        .insert(ledgerEntries)
        .values({ account: "platform_fee", userId: user.id, amountCents: 100, availableAt }),
      PG_ERROR.checkViolation,
      "ledger_entries_platform_has_no_user",
    )
  })
})

describe("GDPR erasure", () => {
  it("lets an erasure transaction delete audience snapshots, and nothing else", async () => {
    const db = testDb.db
    const user = await insertUser(testDb.db)
    const [connection, otherConnection] = await db
      .insert(socialConnections)
      .values([
        { userId: user.id, provider: "github", providerAccountId: `gh-${user.id}` },
        { userId: user.id, provider: "youtube", providerAccountId: `yt-${user.id}` },
      ])
      .returning()
    if (!connection || !otherConnection) throw new Error("no connection")
    const snapshot = await insertSnapshot(connection.id)
    const otherSnapshot = await insertSnapshot(otherConnection.id)
    const [event] = await db
      .insert(events)
      .values({
        type: "social.connected",
        subjectType: "social_connection",
        subjectId: connection.id,
      })
      .returning()
    if (!event) throw new Error("no event")

    await db.transaction(async (tx) => {
      await allowGdprErasure(tx)
      // Updates stay blocked, and only erasable tables accept deletes. Nested transactions are
      // savepoints, so the expected failures don't abort the outer transaction.
      await expectPgError(
        tx.transaction((sp) =>
          sp
            .update(audienceSnapshots)
            .set({ followers: 1 })
            .where(eq(audienceSnapshots.id, snapshot.id)),
        ),
        AO,
      )
      await expectPgError(
        tx.transaction((sp) => sp.delete(events).where(eq(events.id, event.id))),
        AO,
      )
      // Disconnecting the account cascades to its snapshots.
      await tx.delete(socialConnections).where(eq(socialConnections.id, connection.id))
    })

    const left = await db
      .select()
      .from(audienceSnapshots)
      .where(eq(audienceSnapshots.id, snapshot.id))
    expect(left).toHaveLength(0)

    // The flag was transaction-local.
    await expectPgError(
      db.delete(audienceSnapshots).where(eq(audienceSnapshots.id, otherSnapshot.id)),
      AO,
    )
  })
})

import { createHash } from "node:crypto"

import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { allowGdprErasure } from "@/lib/db/append-only"
import { withTransaction, type Tx } from "@/lib/db/client"
import { PG_ERROR } from "@/lib/db/errors"
import {
  agreementSignatures,
  agreements,
  disputes,
  impersonationSessions,
  ledgerAdjustments,
  ledgerEntries,
  matchingConfig,
  proposalRevisions,
  proposals,
  refundRequests,
  users,
} from "@/lib/db/schema"

import { expectPgError, setupTestDatabase } from "../../helpers/db"
import {
  insertAccessGrant,
  insertCollab,
  insertDispute,
  insertImpersonationSession,
  insertLedgerEntry,
  insertLiveLaunch,
  insertOrder,
  insertRefundRequest,
  insertUser,
  matchFeatures,
} from "../../helpers/db-fixtures"

/** The constraints and triggers migration 0011 added for Phases 6–7 (CLAUDE.md §19.38). */

const testDb = setupTestDatabase()
const CHECK = PG_ERROR.checkViolation
const UNIQUE = PG_ERROR.uniqueViolation
const APPEND_ONLY = PG_ERROR.appendOnlyViolation
const T = new Date("2026-03-01T00:00:00Z")
const BODY = "Agreement body (w4 test)."
const BODY_HASH = createHash("sha256").update(BODY, "utf8").digest("hex")

describe("users.deleted_at", () => {
  it("requires a deleted account to be anonymised, suspended and without the admin role", async () => {
    const user = await insertUser(testDb.db)
    const byId = eq(users.id, user.id)
    await expectPgError(
      testDb.db.update(users).set({ deletedAt: T }).where(byId),
      CHECK,
      "users_deleted_anonymised",
    )
    await expectPgError(
      testDb.db
        .update(users)
        .set({ deletedAt: T, email: null, name: null, status: "suspended", roles: ["admin"] })
        .where(byId),
      CHECK,
      "users_deleted_anonymised",
    )
    await testDb.db
      .update(users)
      .set({ deletedAt: T, email: null, name: null, image: null, status: "suspended", roles: [] })
      .where(byId)
    await expectPgError(
      testDb.db.update(users).set({ status: "active" }).where(byId),
      CHECK,
      "users_deleted_anonymised",
    )
  })
})

describe("disputes", () => {
  it("walks open → in_review → resolved with the matching columns", async () => {
    const { collab, creator } = await insertCollab(testDb.db, { stage: "building" })
    const admin = await insertUser(testDb.db, { roles: ["admin"] })
    const dispute = await insertDispute(testDb.db, collab.id, creator.user.id)
    const byId = eq(disputes.id, dispute.id)

    await expectPgError(
      testDb.db.update(disputes).set({ status: "in_review" }).where(byId),
      CHECK,
      "disputes_review_columns",
    )
    await testDb.db
      .update(disputes)
      .set({ status: "in_review", inReviewAt: T, inReviewByUserId: admin.id })
      .where(byId)
    await expectPgError(
      testDb.db.update(disputes).set({ status: "resolved", resolvedAt: T }).where(byId),
      CHECK,
      "disputes_resolution_columns",
    )
    await expectPgError(
      testDb.db.update(disputes).set({ resolutionNote: "early" }).where(byId),
      CHECK,
      "disputes_resolution_columns",
    )
    await testDb.db
      .update(disputes)
      .set({
        status: "resolved",
        resolvedAt: T,
        resolvedBy: admin.id,
        outcome: "adjusted",
        resolutionNote: "Moved €5 to the builder.",
      })
      .where(byId)
  })

  it("allows one unresolved dispute per member and collab, and a non-blank description", async () => {
    const { collab, creator, builder } = await insertCollab(testDb.db, { stage: "building" })
    await insertDispute(testDb.db, collab.id, creator.user.id)
    await expectPgError(
      insertDispute(testDb.db, collab.id, creator.user.id),
      UNIQUE,
      "disputes_one_unresolved_per_member_idx",
    )
    await insertDispute(testDb.db, collab.id, builder.user.id, { kind: "non_delivery" })
    await expectPgError(
      insertDispute(testDb.db, collab.id, builder.user.id, { description: "  " }),
      CHECK,
      "disputes_description",
    )
  })
})

describe("ledger adjustments", () => {
  it("ties adjustment entries to the adjustment account and keeps adjustments append-only", async () => {
    const admin = await insertUser(testDb.db, { roles: ["admin"] })
    const member = await insertUser(testDb.db)
    const [adjustment] = await testDb.db
      .insert(ledgerAdjustments)
      .values({ adminUserId: admin.id, reason: "Dispute settlement" })
      .returning()
    if (!adjustment) throw new Error("no adjustment")
    await insertLedgerEntry(testDb.db, {
      account: "adjustment",
      amountCents: 500,
      userId: member.id,
      adjustmentId: adjustment.id,
    })
    await insertLedgerEntry(testDb.db, {
      account: "adjustment",
      amountCents: -500,
      adjustmentId: adjustment.id,
    })
    await expectPgError(
      insertLedgerEntry(testDb.db, {
        account: "creator_share",
        amountCents: 500,
        userId: member.id,
        adjustmentId: adjustment.id,
      }),
      CHECK,
      "ledger_entries_adjustment_account",
    )
    await expectPgError(
      testDb.db.insert(ledgerAdjustments).values({ adminUserId: admin.id, reason: " " }),
      CHECK,
      "ledger_adjustments_reason",
    )
    await expectPgError(
      testDb.db
        .update(ledgerAdjustments)
        .set({ reason: "changed" })
        .where(eq(ledgerAdjustments.id, adjustment.id)),
      APPEND_ONLY,
    )
    await expectPgError(
      testDb.db.delete(ledgerAdjustments).where(eq(ledgerAdjustments.id, adjustment.id)),
      APPEND_ONLY,
    )
    const entries = await testDb.db
      .select({ amount: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.adjustmentId, adjustment.id))
    expect(entries.reduce((sum, e) => sum + e.amount, 0)).toBe(0)
  })
})

describe("refund requests", () => {
  it("allows one request per order and ties decisions and refunds to the status", async () => {
    const { launch } = await insertLiveLaunch(testDb.db)
    const admin = await insertUser(testDb.db, { roles: ["admin"] })
    const order = await insertOrder(testDb.db, launch.id, T)
    const grant = await insertAccessGrant(testDb.db, order.id)
    const request = await insertRefundRequest(testDb.db, {
      orderId: order.id,
      accessGrantId: grant.id,
    })
    await expectPgError(
      insertRefundRequest(testDb.db, { orderId: order.id, accessGrantId: grant.id }),
      UNIQUE,
      "refund_requests_order_id_unique",
    )
    const byId = eq(refundRequests.id, request.id)
    await expectPgError(
      testDb.db.update(refundRequests).set({ status: "declined" }).where(byId),
      CHECK,
      "refund_requests_decided_columns",
    )
    await expectPgError(
      testDb.db
        .update(refundRequests)
        .set({ status: "approved", decidedAt: T, decidedByUserId: admin.id })
        .where(byId),
      CHECK,
      "refund_requests_refund_iff_approved",
    )
    await testDb.db
      .update(refundRequests)
      .set({ status: "declined", decidedAt: T, decidedByUserId: admin.id, decisionNote: "Used" })
      .where(byId)

    const other = await insertOrder(testDb.db, launch.id, T)
    const otherGrant = await insertAccessGrant(testDb.db, other.id)
    await expectPgError(
      insertRefundRequest(
        testDb.db,
        { orderId: other.id, accessGrantId: otherGrant.id },
        { message: "x".repeat(1001) },
      ),
      CHECK,
      "refund_requests_message",
    )
  })
})

describe("impersonation sessions", () => {
  it("allows one open session per admin, never on themselves, with a reason and an end", async () => {
    const admin = await insertUser(testDb.db, { roles: ["admin"] })
    const target = await insertUser(testDb.db)
    const other = await insertUser(testDb.db)
    const session = await insertImpersonationSession(testDb.db, {
      adminUserId: admin.id,
      targetUserId: target.id,
      startedAt: T,
    })
    await expectPgError(
      insertImpersonationSession(testDb.db, { adminUserId: admin.id, targetUserId: other.id }),
      UNIQUE,
      "impersonation_sessions_one_open_per_admin_idx",
    )
    await expectPgError(
      insertImpersonationSession(testDb.db, { adminUserId: other.id, targetUserId: other.id }),
      CHECK,
      "impersonation_sessions_not_self",
    )
    const byId = eq(impersonationSessions.id, session.id)
    await expectPgError(
      testDb.db.update(impersonationSessions).set({ endedAt: T }).where(byId),
      CHECK,
      "impersonation_sessions_end",
    )
    await expectPgError(
      testDb.db.update(impersonationSessions).set({ endedAt: T, endReason: "bored" }).where(byId),
      CHECK,
      "impersonation_sessions_end",
    )
    await testDb.db
      .update(impersonationSessions)
      .set({ endedAt: T, endReason: "stopped" })
      .where(byId)
    // Ended: a new session may start.
    await insertImpersonationSession(testDb.db, { adminUserId: admin.id, targetUserId: other.id })
  })
})

describe("matching_config v1 columns", () => {
  it("requires a model and a training time for logistic rows", async () => {
    const weights = matchFeatures(0.1)
    await expectPgError(
      testDb.db
        .insert(matchingConfig)
        .values({ modelVersion: "v1-2026-03-01", kind: "logistic", weights }),
      CHECK,
      "matching_config_logistic_has_model",
    )
    const params = {
      intercept: -1,
      coefficients: matchFeatures(0.2),
      means: matchFeatures(0.5),
      stds: matchFeatures(0.1),
    }
    const model = {
      kind: "logistic" as const,
      v: 1 as const,
      scoreTarget: "accepted" as const,
      l2: 1,
      targets: { accepted: params, sale: null },
    }
    await expectPgError(
      testDb.db
        .insert(matchingConfig)
        .values({ modelVersion: "v1-2026-03-02", kind: "logistic", weights, model }),
      CHECK,
      "matching_config_trained_when_logistic",
    )
    await testDb.db.insert(matchingConfig).values({
      modelVersion: "v1-2026-03-03",
      kind: "logistic",
      weights,
      model,
      metrics: { auc: 0.71 },
      trainedAt: T,
    })
    const [v0] = await testDb.db
      .select({ kind: matchingConfig.kind })
      .from(matchingConfig)
      .where(eq(matchingConfig.modelVersion, "v0"))
    expect(v0?.kind).toBe("weighted")
  })
})

describe("proposals.match_snapshot", () => {
  it("must be a JSON object when set", async () => {
    const { proposal } = await insertCollab(testDb.db)
    await expectPgError(
      testDb.db
        .update(proposals)
        .set({ matchSnapshot: sql`'[1]'::jsonb` as never })
        .where(eq(proposals.id, proposal.id)),
      CHECK,
      "proposals_match_snapshot_object",
    )
  })
})

describe("GDPR redaction of append-only rows (§14)", () => {
  async function signedAgreement() {
    const { collab, creator, proposal } = await insertCollab(testDb.db, { stage: "building" })
    const [agreement] = await testDb.db
      .insert(agreements)
      .values({
        collabId: collab.id,
        templateVersion: "v1",
        terms: {
          parties: [],
          scope: "MVP",
          timelineWeeks: 4,
          ip: "joint",
          term: "1y",
          exit: "30d",
        },
        renderedBody: BODY,
        bodyHash: BODY_HASH,
      })
      .returning()
    if (!agreement) throw new Error("no agreement")
    const [signature] = await testDb.db
      .insert(agreementSignatures)
      .values({
        agreementId: agreement.id,
        userId: creator.user.id,
        signedAt: T,
        ip: "203.0.113.7",
        userAgent: "Mozilla/5.0",
        typedName: "Creator Name",
        bodyHash: BODY_HASH,
      })
      .returning()
    if (!signature) throw new Error("no signature")
    return { proposal, signature }
  }

  it("lets erasure null a signature's IP and browser, and a revision's message, only", async () => {
    const { proposal, signature } = await signedAgreement()
    const bySignature = eq(agreementSignatures.id, signature.id)
    const byProposal = eq(proposalRevisions.proposalId, proposal.id)

    // Without the hatch nothing changes.
    await expectPgError(
      testDb.db.update(agreementSignatures).set({ ip: null }).where(bySignature),
      APPEND_ONLY,
    )

    await withTransaction(async (tx) => {
      await allowGdprErasure(tx)
      await tx.update(agreementSignatures).set({ ip: null, userAgent: null }).where(bySignature)
      await tx.update(proposalRevisions).set({ message: null }).where(byProposal)
    }, testDb.db)
    const [after] = await testDb.db.select().from(agreementSignatures).where(bySignature)
    expect(after).toMatchObject({ ip: null, userAgent: null, typedName: "Creator Name" })

    // Even with the hatch: other columns, non-null values and deletes stay blocked.
    for (const change of [
      (tx: Tx) => tx.update(agreementSignatures).set({ typedName: "Someone" }).where(bySignature),
      (tx: Tx) => tx.update(agreementSignatures).set({ userAgent: "changed" }).where(bySignature),
      (tx: Tx) => tx.update(proposalRevisions).set({ scope: "changed" }).where(byProposal),
      (tx: Tx) => tx.delete(agreementSignatures).where(bySignature),
    ]) {
      await expectPgError(
        withTransaction(async (tx) => {
          await allowGdprErasure(tx)
          await change(tx)
        }, testDb.db),
        APPEND_ONLY,
      )
    }
  })
})

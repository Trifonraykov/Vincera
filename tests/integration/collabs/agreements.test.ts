import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { findJob } from "@/inngest/functions"
import { ActionError } from "@/lib/actions/errors"
import { agreementPdfResponse } from "@/lib/agreements/download"
import { finalizeAgreement } from "@/lib/agreements/finalize"
import { agreementBodyHash } from "@/lib/agreements/integrity"
import { agreementPdfKey } from "@/lib/agreements/pdf"
import { AGREEMENT_MESSAGES, signAgreement } from "@/lib/agreements/sign"
import { AGREEMENT_TEMPLATE_V1, renderAgreementV1 } from "@/lib/agreements/template-v1"
import { setClockForTests } from "@/lib/clock"
import { createCollabFromProposal } from "@/lib/collabs/create"
import {
  agreementSignatures,
  agreements,
  collabs,
  notificationPrefs,
  type AgreementTerms,
} from "@/lib/db/schema"
import * as emailSend from "@/lib/email/send"
import { listOutbox } from "@/lib/email/outbox"
import * as proposalNotifications from "@/lib/proposals/notifications"
import { acceptProposal, sendProposal } from "@/lib/proposals/service"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { getStorage } from "@/lib/storage/r2"

import { setupTestDatabase } from "../../helpers/db"
import { onboardedBuilder, onboardedCreator, openIdea, terms } from "../proposals/helpers"
import { insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  acceptedCollab,
  authUserOf,
  eventsOf,
  makePayoutsReady,
  makeTempDataDir,
  notificationsOf,
  removeTempDataDir,
} from "./helpers"

/**
 * Agreements against Postgres (§12 "Agreement page", §16 Phase 3, CLAUDE.md §19.28): generation on
 * acceptance, click-signing (payouts-ready, typed name, the text signed, integrity, idempotency,
 * races), completion (stage `building`, events), the finalize job (PDF stored, emailed to both
 * with the PDF attached, once) and the PDF download route.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
// The finalize job resolves the app's database itself; point it at this file's database.
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")

beforeAll(async () => {
  mocks.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dir)
})
beforeEach(() => {
  mocks.db = testDb.db
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(() => setClockForTests(null))

async function emailsTo(email: string | null) {
  return (await listOutbox()).filter((message) => email && message.to.includes(email))
}

async function agreementRow(id: string) {
  const [row] = await testDb.db.select().from(agreements).where(eq(agreements.id, id))
  if (!row) throw new Error("no agreement")
  return row
}

function signInput(agreement: { id: string; bodyHash: string }, typedName = "Ada Lovelace") {
  return {
    agreementId: agreement.id,
    typedName,
    bodyHash: agreement.bodyHash,
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0 (Test)",
  }
}

async function rejectsWith(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(ActionError)
  await expect(promise).rejects.toThrow(message)
}

describe("agreement generation", () => {
  it("creates the agreement with the accepted terms when a proposal is accepted", async () => {
    const { creator, builder, collabId, agreement } = await acceptedCollab(testDb.db, {
      creatorSplitPct: 65,
      scope: "A web app with budgets.\n\nPlus CSV import.",
    })
    expect(agreement).toMatchObject({
      collabId,
      templateVersion: AGREEMENT_TEMPLATE_V1,
      status: "awaiting_signatures",
      completedAt: null,
      pdfStorageKey: null,
      createdAt: NOW,
    })
    const terms: AgreementTerms = agreement.terms
    expect(terms.parties).toEqual([
      {
        userId: creator.user.id,
        role: "creator",
        name: creator.profile.displayName,
        splitPct: 65,
      },
      {
        userId: builder.user.id,
        role: "builder",
        name: builder.profile.displayName,
        splitPct: 35,
      },
    ])
    expect(terms).toMatchObject({
      scope: "A web app with budgets.\n\nPlus CSV import.",
      timelineWeeks: 6,
    })
    // The text is the template rendered from the snapshot, and the hash is its SHA-256.
    expect(agreement.renderedBody).toBe(renderAgreementV1(terms, { collabId, generatedAt: NOW }))
    expect(agreement.bodyHash).toBe(agreementBodyHash(agreement.renderedBody))
    expect(agreement.renderedBody).toContain("Draft — pending legal review")
    expect(agreement.renderedBody).toContain(
      `the Creator (${creator.profile.displayName}) receives 65%;`,
    )
    expect(agreement.renderedBody).toContain("> A web app with budgets.\n>\n> Plus CSV import.")

    const [generated] = await eventsOf(testDb.db, agreement.id, "agreement.generated")
    expect(generated).toMatchObject({ actorUserId: creator.user.id })
    expect(generated?.properties).toEqual({ collab_id: collabId, template_version: "v1" })

    for (const person of [creator, builder]) {
      const [ready] = await notificationsOf(testDb.db, person.user.id, "agreement.ready")
      expect(ready?.payload).toEqual({
        collab_id: collabId,
        agreement_id: agreement.id,
        collab_title: "Budget tracker for students",
      })
      const subjects = (await emailsTo(person.user.email)).map((email) => email.subject)
      expect(subjects).toContain(
        "Your agreement for “Budget tracker for students” is ready to sign",
      )
    }
  })

  it("tells nobody to sign when the acceptance rolls back", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const idea = await openIdea(testDb.db, creator, "Rolled back tracker")
    const { proposalId, revisionId } = await sendProposal(testDb.db, builder.auth, {
      recipientId: creator.user.id,
      target: { kind: "idea", id: idea.id },
      matchId: null,
      terms: terms({ creatorSplitPct: 60, builderSplitPct: 40 }),
    })
    // A failure after the collab and agreement were written, inside the accepting transaction.
    const spy = vi
      .spyOn(proposalNotifications, "notifyProposalAccepted")
      .mockRejectedValueOnce(new Error("late failure"))
    await expect(
      acceptProposal(testDb.db, creator.auth, { proposalId, revisionId }),
    ).rejects.toThrow("late failure")
    spy.mockRestore()

    for (const person of [creator, builder]) {
      expect(await notificationsOf(testDb.db, person.user.id, "agreement.ready")).toHaveLength(0)
      const subjects = (await emailsTo(person.user.email)).map((email) => email.subject)
      expect(subjects.filter((subject) => subject.includes("ready to sign"))).toEqual([])
    }
  })

  it("returns the existing agreement when the collab already exists", async () => {
    const { proposalId, collabId, agreement, creator } = await acceptedCollab(testDb.db)
    const again = await testDb.db.transaction((tx) =>
      createCollabFromProposal(proposalId, tx, { actorUserId: creator.user.id }),
    )
    expect(again).toMatchObject({ collabId, created: false, agreementId: agreement.id })
    const rows = await testDb.db.select().from(agreements).where(eq(agreements.collabId, collabId))
    expect(rows).toHaveLength(1)
  })
})

describe("signAgreement", () => {
  it("needs both members payouts-ready, and says who still has to set them up", async () => {
    const { creator, builder, agreement } = await acceptedCollab(testDb.db)
    await rejectsWith(
      signAgreement(testDb.db, creator.auth, signInput(agreement)),
      AGREEMENT_MESSAGES.payoutsBoth(builder.profile.displayName),
    )
    await makePayoutsReady(testDb.db, creator.user.id)
    await rejectsWith(
      signAgreement(testDb.db, creator.auth, signInput(agreement)),
      AGREEMENT_MESSAGES.payoutsOther(builder.profile.displayName),
    )
    await rejectsWith(
      signAgreement(testDb.db, builder.auth, signInput(agreement)),
      AGREEMENT_MESSAGES.payoutsSelf,
    )
    expect(
      await testDb.db
        .select()
        .from(agreementSignatures)
        .where(eq(agreementSignatures.agreementId, agreement.id)),
    ).toHaveLength(0)
  })

  it("needs the typed full name and the text the signer was shown", async () => {
    const { creator, builder, agreement } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)

    const missing = signAgreement(testDb.db, creator.auth, signInput(agreement, "   "))
    await expect(missing).rejects.toThrow("Type your full name to sign.")
    await expect(missing).rejects.toMatchObject({
      fieldErrors: { typedName: ["Type your full name to sign."] },
    })
    await rejectsWith(
      signAgreement(testDb.db, creator.auth, {
        ...signInput(agreement),
        bodyHash: agreementBodyHash("an older text"),
      }),
      AGREEMENT_MESSAGES.stale,
    )
  })

  it("refuses to sign an agreement whose terms were changed after it was generated", async () => {
    const { creator, builder, agreement } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    const terms: AgreementTerms = agreement.terms
    // Someone edits the snapshot's split behind the text's back.
    await testDb.db
      .update(agreements)
      .set({
        terms: {
          ...terms,
          parties: terms.parties.map((party) => ({
            ...party,
            splitPct: party.role === "creator" ? 90 : 10,
          })),
        },
      })
      .where(eq(agreements.id, agreement.id))
    await rejectsWith(
      signAgreement(testDb.db, creator.auth, signInput(agreement)),
      AGREEMENT_MESSAGES.integrity,
    )
  })

  it("refuses when the members' splits no longer match the signed text", async () => {
    const { creator, builder, agreement, collabId } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    const { collabMembers } = await import("@/lib/db/schema")
    await testDb.db
      .update(collabMembers)
      .set({ splitPct: 70 })
      .where(eq(collabMembers.collabId, collabId))
    await rejectsWith(
      signAgreement(testDb.db, creator.auth, signInput(agreement)),
      AGREEMENT_MESSAGES.integrity,
    )
  })

  it("is only for the collab's members", async () => {
    const { creator, builder, agreement } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    const stranger = authUserOf(await insertUser(testDb.db, { roles: ["builder"] }))
    const admin = authUserOf(await insertUser(testDb.db, { roles: ["admin"] }))
    for (const user of [stranger, admin]) {
      await rejectsWith(
        signAgreement(testDb.db, user, signInput(agreement)),
        AGREEMENT_MESSAGES.notFound,
      )
    }
  })

  it("records one signature per member and is idempotent", async () => {
    const { creator, builder, agreement, collabId } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    const later = new Date(NOW.getTime() + 60_000)
    setClockForTests(later)

    const first = await signAgreement(
      testDb.db,
      creator.auth,
      signInput(agreement, "  Ada   Lovelace "),
    )
    expect(first).toEqual({ status: "signed", completed: false, collabId })
    const again = await signAgreement(testDb.db, creator.auth, signInput(agreement))
    expect(again).toEqual({ status: "already_signed", completed: false, collabId })

    const signatures = await testDb.db
      .select()
      .from(agreementSignatures)
      .where(eq(agreementSignatures.agreementId, agreement.id))
    expect(signatures).toHaveLength(1)
    expect(signatures[0]).toMatchObject({
      userId: creator.user.id,
      typedName: "Ada Lovelace",
      signedAt: later,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (Test)",
      bodyHash: agreement.bodyHash,
    })
    const signed = await eventsOf(testDb.db, agreement.id, "agreement.signed")
    expect(signed).toHaveLength(1)
    expect(signed[0]).toMatchObject({ actorUserId: creator.user.id })
    expect(signed[0]?.properties).toEqual({ collab_id: collabId, role: "creator" })
    expect((await agreementRow(agreement.id)).status).toBe("awaiting_signatures")
    const [collab] = await testDb.db.select().from(collabs).where(eq(collabs.id, collabId))
    expect(collab).toMatchObject({ stage: "agreement", lastActivityAt: later })

    // The builder hears that it's their turn, once.
    const notices = await notificationsOf(testDb.db, builder.user.id, "agreement.signed")
    expect(notices).toHaveLength(1)
    expect(notices[0]?.payload).toMatchObject({
      agreement_id: agreement.id,
      signer_name: creator.profile.displayName,
    })
    expect(await notificationsOf(testDb.db, creator.user.id, "agreement.signed")).toHaveLength(0)
  })

  it("stores an IP only when it is an address", async () => {
    const { creator, builder, agreement } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    await signAgreement(testDb.db, creator.auth, { ...signInput(agreement), ip: "unknown" })
    const [signature] = await testDb.db
      .select()
      .from(agreementSignatures)
      .where(eq(agreementSignatures.agreementId, agreement.id))
    expect(signature?.ip).toBeNull()
  })

  it("completes when both signed: building, events, then the PDF stored and emailed once", async () => {
    const { creator, builder, agreement, collabId } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    await signAgreement(testDb.db, creator.auth, signInput(agreement, "Ada Lovelace"))
    const done = new Date(NOW.getTime() + 3_600_000)
    setClockForTests(done)
    // The last signature enqueues the finalize job, which runs inline here (fake jobs).
    const result = await signAgreement(testDb.db, builder.auth, signInput(agreement, "Bo Builder"))
    expect(result).toEqual({ status: "signed", completed: true, collabId })

    const row = await agreementRow(agreement.id)
    expect(row).toMatchObject({
      status: "signed",
      completedAt: done,
      pdfStorageKey: agreementPdfKey(collabId, agreement.id),
    })
    const [collab] = await testDb.db.select().from(collabs).where(eq(collabs.id, collabId))
    expect(collab).toMatchObject({ stage: "building", stageChangedAt: done })
    expect((await eventsOf(testDb.db, agreement.id)).map((event) => event.type)).toEqual([
      "agreement.generated",
      "agreement.signed",
      "agreement.signed",
      "agreement.completed",
    ])
    const [completed] = await eventsOf(testDb.db, agreement.id, "agreement.completed")
    expect(completed?.properties).toEqual({ collab_id: collabId, template_version: "v1" })
    const stageChanges = await eventsOf(testDb.db, collabId, "collab.stage_changed")
    expect(stageChanges.map((event) => event.properties)).toEqual([
      { from: "agreement", to: "building" },
    ])

    // The PDF is in storage.
    const stored = await getStorage().getObject(row.pdfStorageKey ?? "")
    expect(stored?.contentType).toBe("application/pdf")
    expect(
      Buffer.from(stored?.body ?? [])
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-")
    expect(stored?.sizeBytes).toBeGreaterThan(2000)

    // Both got the email with the PDF attached, and the in-app notification.
    for (const person of [creator, builder]) {
      const emails = (await emailsTo(person.user.email)).filter(
        (email) => email.subject === "Your agreement for “Budget tracker for students” is signed",
      )
      expect(emails).toHaveLength(1)
      expect(emails[0]?.attachments).toEqual([
        {
          filename: "collaboration-agreement-budget-tracker-for-students.pdf",
          contentType: "application/pdf",
          sizeBytes: stored?.sizeBytes,
        },
      ])
      expect(await notificationsOf(testDb.db, person.user.id, "agreement.completed")).toHaveLength(
        1,
      )
    }

    // Running the job again renders and sends nothing new.
    const job = findJob("agreements-finalize")
    expect(await job?.runInline({ agreementId: agreement.id })).toEqual({
      pdfStorageKey: row.pdfStorageKey,
      rendered: false,
      notified: 2,
    })
    for (const person of [creator, builder]) {
      expect(await notificationsOf(testDb.db, person.user.id, "agreement.completed")).toHaveLength(
        1,
      )
      const emails = (await emailsTo(person.user.email)).filter((email) =>
        email.subject.endsWith("is signed"),
      )
      expect(emails).toHaveLength(1)
    }

    // A third signature attempt is refused politely; the signers get success again.
    expect(await signAgreement(testDb.db, creator.auth, signInput(agreement))).toEqual({
      status: "already_signed",
      completed: true,
      collabId,
    })
  })

  it("completes exactly once when both members sign at the same moment", async () => {
    const { creator, builder, agreement, collabId } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    const results = await Promise.all([
      signAgreement(testDb.db, creator.auth, signInput(agreement, "Ada Lovelace")),
      signAgreement(testDb.db, builder.auth, signInput(agreement, "Bo Builder")),
    ])
    expect(results.filter((result) => result.completed)).toHaveLength(1)
    expect(await eventsOf(testDb.db, agreement.id, "agreement.completed")).toHaveLength(1)
    expect(await eventsOf(testDb.db, collabId, "collab.stage_changed")).toHaveLength(1)
    expect((await agreementRow(agreement.id)).status).toBe("signed")
  })

  it("cannot be signed once the collab has ended", async () => {
    const { creator, builder, agreement, collabId } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    await testDb.db
      .update(collabs)
      .set({ stage: "ended", endedAt: NOW, endedReason: "cancelled" })
      .where(eq(collabs.id, collabId))
    await rejectsWith(
      signAgreement(testDb.db, creator.auth, signInput(agreement)),
      AGREEMENT_MESSAGES.collabEnded,
    )
  })
})

describe("finalizeAgreement", () => {
  it("skips agreements that are not fully signed", async () => {
    const { agreement } = await acceptedCollab(testDb.db)
    expect(await finalizeAgreement(testDb.db, agreement.id)).toEqual({ skipped: "not_signed" })
  })

  it("fails the email step when the send fails, so a retry delivers the PDF", async () => {
    const { creator, builder, agreement } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    // The creator switched agreement emails off: the signed PDF is a legal record and still goes.
    await testDb.db
      .insert(notificationPrefs)
      .values({ userId: creator.user.id, type: "agreement.completed", email: false, inApp: true })
    await signAgreement(testDb.db, creator.auth, signInput(agreement, "Ada Lovelace"))
    // The inline finalize run after the last signature hits a Resend outage.
    const send = vi.spyOn(emailSend, "sendEmail").mockRejectedValue(new Error("Resend is down"))
    await signAgreement(testDb.db, builder.auth, signInput(agreement, "Bo Builder"))
    expect(await finalizeAgreement(testDb.db, agreement.id).catch((error) => error)).toBeInstanceOf(
      Error,
    )
    expect(await notificationsOf(testDb.db, creator.user.id, "agreement.completed")).toHaveLength(0)
    send.mockRestore()

    // The retry (or the daily safety net) sends both, once.
    expect(await finalizeAgreement(testDb.db, agreement.id)).toMatchObject({ notified: 2 })
    for (const person of [creator, builder]) {
      const emails = (await emailsTo(person.user.email)).filter((email) =>
        email.subject.endsWith("is signed"),
      )
      expect(emails).toHaveLength(1)
      expect(await notificationsOf(testDb.db, person.user.id, "agreement.completed")).toHaveLength(
        1,
      )
    }
  })
})

describe("the PDF download route", () => {
  it("redirects members to a short-lived URL and answers 404 to everyone else", async () => {
    const { creator, builder, agreement } = await acceptedCollab(testDb.db)
    // No PDF yet: nothing to download.
    const early = await agreementPdfResponse(
      { agreementId: agreement.id },
      { db: testDb.db, user: creator.auth },
    )
    expect(early.status).toBe(404)

    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    await signAgreement(testDb.db, creator.auth, signInput(agreement, "Ada Lovelace"))
    await signAgreement(testDb.db, builder.auth, signInput(agreement, "Bo Builder"))

    const response = await agreementPdfResponse(
      { agreementId: agreement.id },
      { db: testDb.db, user: builder.auth },
    )
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toContain("/api/dev/storage/agreements/")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")

    const stranger = authUserOf(await insertUser(testDb.db, { roles: ["creator"] }))
    const admin = authUserOf(await insertUser(testDb.db, { roles: ["admin"] }))
    for (const [user, status] of [
      [stranger, 404],
      [null, 404],
      [admin, 302],
    ] as const) {
      const answer = await agreementPdfResponse(
        { agreementId: agreement.id },
        { db: testDb.db, user },
      )
      expect(answer.status).toBe(status)
    }
    const malformed = await agreementPdfResponse(
      { agreementId: "not-a-uuid" },
      { db: testDb.db, user: creator.auth },
    )
    expect(malformed.status).toBe(404)
  })
})

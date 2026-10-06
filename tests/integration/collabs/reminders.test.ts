import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { findJob } from "@/inngest/functions"
import { signAgreement } from "@/lib/agreements/sign"
import { setClockForTests } from "@/lib/clock"
import { touchCollabActivity } from "@/lib/collabs/activity"
import {
  refinalizeSignedAgreements,
  remindStalledCollabs,
  remindUnsignedAgreements,
} from "@/lib/collabs/reminders"
import { agreements, collabs, notifications } from "@/lib/db/schema"
import { listOutbox } from "@/lib/email/outbox"
import * as enqueueModule from "@/lib/jobs/enqueue"
import { resetMemoryRateLimits } from "@/lib/ratelimit"

import { setupTestDatabase } from "../../helpers/db"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  acceptedCollab,
  makePayoutsReady,
  makeTempDataDir,
  notificationsOf,
  removeTempDataDir,
  setUserStatus,
} from "./helpers"

/**
 * `reminders/stalled` against Postgres (§13, CLAUDE.md §19.24 "Reminders"): collabs idle for 7+
 * days, agreements unsigned after 3 days, once each (dedupe keys), active members only, and the
 * PDF safety net; then the job itself.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000
const days = (count: number) => new Date(NOW.getTime() + count * DAY)

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

async function moveCollabTo(collabId: string, stage: "building" | "ended") {
  await testDb.db
    .update(collabs)
    .set(
      stage === "ended"
        ? { stage, endedAt: NOW, endedReason: "cancelled" }
        : { stage, stageChangedAt: NOW },
    )
    .where(eq(collabs.id, collabId))
}

describe("collab.stalled", () => {
  it("nudges both members of a collab idle for 7 days, once per quiet spell", async () => {
    const { creator, builder, collabId } = await acceptedCollab(testDb.db)
    await moveCollabTo(collabId, "building")

    // Six days: nothing yet.
    expect(await remindStalledCollabs(testDb.db, days(6))).toMatchObject({ stalledNotices: 0 })
    const week = await remindStalledCollabs(testDb.db, days(8))
    expect(week).toEqual({ stalledCollabs: 1, stalledNotices: 2, failed: 0 })
    for (const person of [creator, builder]) {
      const notices = await notificationsOf(testDb.db, person.user.id, "collab.stalled")
      expect(notices.map((notice) => notice.payload)).toEqual([
        { collab_id: collabId, collab_title: "Budget tracker for students", idle_days: 8 },
      ])
      const subjects = (await listOutbox())
        .filter((email) => person.user.email && email.to.includes(person.user.email))
        .map((email) => email.subject)
      expect(subjects).toContain("“Budget tracker for students” has gone quiet")
    }
    // The next day: the same quiet spell, nothing new.
    expect(await remindStalledCollabs(testDb.db, days(9))).toMatchObject({ stalledNotices: 0 })

    // Activity starts a new spell; a week later they hear again.
    await touchCollabActivity(testDb.db, collabId, days(10))
    expect(await remindStalledCollabs(testDb.db, days(16))).toMatchObject({ stalledNotices: 0 })
    expect(await remindStalledCollabs(testDb.db, days(18))).toMatchObject({ stalledNotices: 2 })
    expect(await notificationsOf(testDb.db, creator.user.id, "collab.stalled")).toHaveLength(2)
  })

  it("leaves ended collabs and suspended members alone", async () => {
    const ended = await acceptedCollab(testDb.db)
    await moveCollabTo(ended.collabId, "ended")
    const quiet = await acceptedCollab(testDb.db)
    await setUserStatus(testDb.db, quiet.builder.user.id, "suspended")

    const result = await remindStalledCollabs(testDb.db, days(8))
    expect(result.failed).toBe(0)
    expect(await notificationsOf(testDb.db, ended.creator.user.id, "collab.stalled")).toHaveLength(
      0,
    )
    expect(await notificationsOf(testDb.db, quiet.creator.user.id, "collab.stalled")).toHaveLength(
      1,
    )
    expect(await notificationsOf(testDb.db, quiet.builder.user.id, "collab.stalled")).toHaveLength(
      0,
    )
  })
})

describe("agreement.reminder", () => {
  it("reminds members who have not signed, three days after generation, once", async () => {
    const { creator, builder, collabId, agreement } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    await signAgreement(testDb.db, creator.auth, {
      agreementId: agreement.id,
      typedName: "Ada Lovelace",
      bodyHash: agreement.bodyHash,
      ip: null,
      userAgent: null,
    })

    const reminders = async () =>
      (await notificationsOf(testDb.db, builder.user.id, "agreement.reminder")).length
    await remindUnsignedAgreements(testDb.db, days(2))
    expect(await reminders()).toBe(0)
    expect(await remindUnsignedAgreements(testDb.db, days(3))).toMatchObject({ failed: 0 })
    expect(await reminders()).toBe(1)
    await remindUnsignedAgreements(testDb.db, days(4))
    expect(await reminders()).toBe(1)
    const [reminder] = await notificationsOf(testDb.db, builder.user.id, "agreement.reminder")
    expect(reminder?.payload).toEqual({
      collab_id: collabId,
      agreement_id: agreement.id,
      collab_title: "Budget tracker for students",
      days_waiting: 3,
    })
    expect(await notificationsOf(testDb.db, creator.user.id, "agreement.reminder")).toHaveLength(0)
  })

  it("stops once the agreement is signed by both", async () => {
    const { creator, builder, agreement } = await acceptedCollab(testDb.db)
    await makePayoutsReady(testDb.db, creator.user.id)
    await makePayoutsReady(testDb.db, builder.user.id)
    for (const [person, name] of [
      [creator, "Ada Lovelace"],
      [builder, "Bo Builder"],
    ] as const) {
      await signAgreement(testDb.db, person.auth, {
        agreementId: agreement.id,
        typedName: name,
        bodyHash: agreement.bodyHash,
        ip: null,
        userAgent: null,
      })
    }
    await remindUnsignedAgreements(testDb.db, days(5))
    for (const person of [creator, builder]) {
      expect(await notificationsOf(testDb.db, person.user.id, "agreement.reminder")).toHaveLength(0)
    }
  })
})

describe("refinalizeSignedAgreements", () => {
  it("re-sends finalize for a missing PDF email, with a fresh event id per day", async () => {
    const { creator, collabId, agreement } = await acceptedCollab(testDb.db, { title: "Sleep log" })
    await testDb.db
      .update(agreements)
      .set({
        status: "signed",
        completedAt: NOW,
        pdfStorageKey: `agreements/${collabId}/${agreement.id}.pdf`,
      })
      .where(eq(agreements.id, agreement.id))
    // The creator got the signed PDF; the builder's email failed (no row: a required email's row
    // only exists once it was sent).
    await testDb.db.insert(notifications).values({
      userId: creator.user.id,
      type: "agreement.completed",
      payload: { collab_id: collabId, agreement_id: agreement.id, collab_title: "Sleep log" },
      dedupeKey: `agreement.completed:${agreement.id}:${creator.user.id}`,
    })
    const sent: (string | undefined)[] = []
    const spy = vi.spyOn(enqueueModule, "enqueue").mockImplementation(async (_name, data, opts) => {
      if ("agreementId" in data && data.agreementId === agreement.id) sent.push(opts?.id)
    })
    try {
      await refinalizeSignedAgreements(testDb.db, days(1))
      await refinalizeSignedAgreements(testDb.db, days(2))
      // A week later the safety net gives up (an address that never accepts mail).
      await refinalizeSignedAgreements(testDb.db, days(8))
    } finally {
      spy.mockRestore()
    }
    expect(sent).toEqual([
      `finalize:${agreement.id}:retry:${days(1).toISOString().slice(0, 10)}`,
      `finalize:${agreement.id}:retry:${days(2).toISOString().slice(0, 10)}`,
    ])
  })
})

describe("the reminders-stalled job", () => {
  it("runs both reminders and finalizes signed agreements left without a PDF", async () => {
    const quiet = await acceptedCollab(testDb.db)
    // A signed agreement whose finalize never ran (e.g. the enqueue failed after the commit).
    const signed = await acceptedCollab(testDb.db, { title: "Habit tracker" })
    await testDb.db
      .update(agreements)
      .set({ status: "signed", completedAt: days(7) })
      .where(eq(agreements.id, signed.agreement.id))
    await moveCollabTo(signed.collabId, "building")
    expect(await refinalizeSignedAgreements(testDb.db, new Date(days(7).getTime() + 60_000))).toBe(
      0,
    )

    const job = findJob("reminders-stalled")
    setClockForTests(days(8))
    const result = await job?.runInline({})
    // Earlier tests' collabs share this database, so only lower bounds are exact here.
    expect(result).toMatchObject({ finalizeRequested: 1 })
    for (const person of [quiet.creator, quiet.builder, signed.creator, signed.builder]) {
      expect(await notificationsOf(testDb.db, person.user.id, "collab.stalled")).toHaveLength(1)
    }
    const [after] = await testDb.db
      .select()
      .from(agreements)
      .where(eq(agreements.id, signed.agreement.id))
    expect(after?.pdfStorageKey).toBe(`agreements/${signed.collabId}/${signed.agreement.id}.pdf`)
    expect(
      await notificationsOf(testDb.db, quiet.creator.user.id, "agreement.reminder"),
    ).toHaveLength(1)
  })
})

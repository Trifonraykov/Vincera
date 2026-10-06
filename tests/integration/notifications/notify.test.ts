import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq } from "drizzle-orm"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { notificationPrefs, notifications, users } from "@/lib/db/schema"
import * as emailSend from "@/lib/email/send"
import { listOutbox } from "@/lib/email/outbox"
import NotificationEmail from "@/lib/email/templates/notification"
import { notify } from "@/lib/notifications/notify"

import { setupTestDatabase } from "../../helpers/db"
import { insertSocialConnection, insertUser } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"

// The fake email transport writes to a temporary outbox instead of the repo's .data/.
const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(dataRoot.dir, ...segments) }
})

const testDb = setupTestDatabase()

beforeEach(async () => {
  dataRoot.dir = await mkdtemp(path.join(tmpdir(), "notify-test-"))
  stubServiceEnv()
})

afterEach(async () => {
  await rm(dataRoot.dir, { recursive: true, force: true })
})

function expiredEmail() {
  return {
    subject: "Reconnect your YouTube channel",
    react: createElement(NotificationEmail, {
      appName: "Vincera",
      heading: "Reconnect your YouTube channel",
      paragraphs: ["Access to your channel expired."],
      action: { label: "Reconnect", url: "http://localhost:3000/app/settings/connections" },
    }),
  }
}

async function setup() {
  const user = await insertUser(testDb.db)
  const connection = await insertSocialConnection(testDb.db, user.id)
  return {
    user,
    input: {
      userId: user.id,
      type: "social.expired" as const,
      payload: { connection_id: connection.id, provider: "youtube" as const },
    },
  }
}

async function rowsOf(userId: string) {
  return testDb.db.select().from(notifications).where(eq(notifications.userId, userId))
}

describe("notify", () => {
  it("writes an in-app notification and sends the email by default", async () => {
    const { user, input } = await setup()
    const result = await notify({ ...input, email: expiredEmail() }, testDb.db)

    expect(result).toMatchObject({ emailed: true, duplicate: false })
    const rows = await rowsOf(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: result.notificationId,
      type: "social.expired",
      payload: input.payload,
      readAt: null,
      dedupeKey: null,
      inApp: true,
    })

    const outbox = await listOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({
      to: [user.email],
      subject: "Reconnect your YouTube channel",
      tags: { notification: "social_expired" },
    })
    expect(outbox[0]?.html).toContain("Access to your channel expired.")
    expect(outbox[0]?.text).toContain("http://localhost:3000/app/settings/connections")
  })

  it("is in-app only without email content", async () => {
    const { user, input } = await setup()
    expect(await notify(input, testDb.db)).toMatchObject({ emailed: false })
    expect(await rowsOf(user.id)).toHaveLength(1)
    expect(await listOutbox()).toHaveLength(0)
  })

  it("follows notification_prefs per type", async () => {
    const { user, input } = await setup()
    await testDb.db.insert(notificationPrefs).values([
      { userId: user.id, type: "social.expired", email: false, inApp: true },
      { userId: user.id, type: "payouts.ready", email: true, inApp: false },
    ])

    expect(await notify({ ...input, email: expiredEmail() }, testDb.db)).toMatchObject({
      emailed: false,
    })
    const ready = await notify(
      {
        userId: user.id,
        type: "payouts.ready",
        payload: { stripe_account_id: "acct_test_0001" },
        email: { ...expiredEmail(), subject: "Your payouts are set up" },
      },
      testDb.db,
    )
    expect(ready).toEqual({ notificationId: null, emailed: true, duplicate: false })

    expect((await rowsOf(user.id)).map((row) => row.type)).toEqual(["social.expired"])
    expect((await listOutbox()).map((email) => email.subject)).toEqual(["Your payouts are set up"])
  })

  it("writes and sends nothing twice for the same dedupe key", async () => {
    const { user, input } = await setup()
    const first = await notify({ ...input, email: expiredEmail(), dedupeKey: "k1" }, testDb.db)
    const second = await notify({ ...input, email: expiredEmail(), dedupeKey: "k1" }, testDb.db)
    expect(first.duplicate).toBe(false)
    expect(second).toEqual({ notificationId: null, emailed: false, duplicate: true })
    await notify({ ...input, dedupeKey: "k2" }, testDb.db)

    expect((await rowsOf(user.id)).map((row) => row.dedupeKey).sort()).toEqual(["k1", "k2"])
    expect(await listOutbox()).toHaveLength(1)
  })

  it("claims the dedupe key when in-app is off, so the email goes out once", async () => {
    const { user } = await setup()
    await testDb.db
      .insert(notificationPrefs)
      .values({ userId: user.id, type: "payouts.ready", email: true, inApp: false })
    const ready = {
      userId: user.id,
      type: "payouts.ready" as const,
      payload: { stripe_account_id: "acct_test_0001" },
      email: { ...expiredEmail(), subject: "Your payouts are set up" },
      dedupeKey: "payouts.ready:acct_1",
    }

    expect(await notify(ready, testDb.db)).toEqual({
      notificationId: null,
      emailed: true,
      duplicate: false,
    })
    expect(await notify(ready, testDb.db)).toEqual({
      notificationId: null,
      emailed: false,
      duplicate: true,
    })

    expect(await listOutbox()).toHaveLength(1)
    // The row only records the delivery; in-app lists show `in_app = true` rows.
    expect(await rowsOf(user.id)).toMatchObject([
      { type: "payouts.ready", dedupeKey: "payouts.ready:acct_1", inApp: false },
    ])
  })

  it("commits the in-app row with the caller's transaction", async () => {
    const { user, input } = await setup()
    await expect(
      testDb.db.transaction(async (tx) => {
        await notify(input, tx)
        throw new Error("rollback")
      }),
    ).rejects.toThrow("rollback")
    expect(await rowsOf(user.id)).toHaveLength(0)
  })

  it("never fails the caller when the email cannot be sent", async () => {
    const { user, input } = await setup()
    vi.spyOn(emailSend, "sendEmail").mockRejectedValueOnce(new Error("Resend is down"))
    const result = await notify({ ...input, email: expiredEmail() }, testDb.db)
    expect(result).toMatchObject({ emailed: false, duplicate: false })
    expect(await rowsOf(user.id)).toHaveLength(1)
  })

  it("sends a required email whatever the preference, and releases the key when it fails", async () => {
    const { user, input } = await setup()
    await testDb.db
      .insert(notificationPrefs)
      .values({ userId: user.id, type: "social.expired", email: false, inApp: true })
    const required = {
      ...input,
      email: { ...expiredEmail(), required: true },
      dedupeKey: "required:1",
    }

    // A failed send throws, and leaves neither the claim nor the in-app row behind...
    vi.spyOn(emailSend, "sendEmail").mockRejectedValueOnce(new Error("Resend is down"))
    await expect(notify(required, testDb.db)).rejects.toThrow("Resend is down")
    expect(await rowsOf(user.id)).toHaveLength(0)
    expect(await listOutbox()).toHaveLength(0)

    // ...so the retry sends it (the email preference is off: a required email ignores it).
    expect(await notify(required, testDb.db)).toMatchObject({ emailed: true, duplicate: false })
    expect(await notify(required, testDb.db)).toMatchObject({ emailed: false, duplicate: true })
    expect(await rowsOf(user.id)).toHaveLength(1)
    expect(await listOutbox()).toHaveLength(1)
  })

  it("skips the email for an account without an email address (anonymised)", async () => {
    const { user, input } = await setup()
    await testDb.db.update(users).set({ email: null }).where(eq(users.id, user.id))
    expect(await notify({ ...input, email: expiredEmail() }, testDb.db)).toMatchObject({
      emailed: false,
    })
    expect(await rowsOf(user.id)).toHaveLength(1)
  })

  it("rejects unknown users", async () => {
    await expect(
      notify(
        {
          userId: "0190a000-0000-7000-8000-00000000dead",
          type: "payouts.ready",
          payload: { stripe_account_id: "acct_test_0001" },
        },
        testDb.db,
      ),
    ).rejects.toThrow("not found")
  })

  it("refuses a payload that does not match its type's schema (lists must parse every row)", async () => {
    const user = await insertUser(testDb.db)
    await expect(
      notify(
        {
          userId: user.id,
          type: "payouts.ready",
          // @ts-expect-error -- the payload of another type
          payload: { connection_id: "0190a000-0000-7000-8000-000000000001", provider: "youtube" },
        },
        testDb.db,
      ),
    ).rejects.toThrow()
    const rows = await testDb.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.id))
    expect(rows).toHaveLength(0)
  })
})

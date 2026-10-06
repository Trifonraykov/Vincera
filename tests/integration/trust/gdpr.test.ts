import { randomUUID } from "node:crypto"

import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb, type Db } from "@/lib/db/client"
import {
  accounts,
  agreementSignatures,
  audienceSnapshots,
  builderProfiles,
  collabs,
  creatorProfiles,
  events,
  handles,
  ideas,
  ledgerEntries,
  matches,
  messages,
  notificationPrefs,
  notifications,
  orders,
  portfolioItems,
  proposalRevisions,
  proposals,
  savedItems,
  sessions,
  socialConnections,
  stripeEvents,
  threads,
  users,
} from "@/lib/db/schema"
import { listOutbox } from "@/lib/email/outbox"
import {
  accountDeletionBlockers,
  AccountDeletionBlockedError,
  DELETED_DISPLAY_NAME,
  DELETED_MESSAGE_BODY,
  deleteAccount,
} from "@/lib/gdpr/delete"
import { buildDataExport, DATA_EXPORT_SECTIONS, dataExportFilename } from "@/lib/gdpr/export"
import { dataExportResponse } from "@/lib/gdpr/export-route"
import { sendProposal } from "@/lib/proposals/service"
import { resetMemoryRateLimits } from "@/lib/ratelimit"
import { getStorage } from "@/lib/storage/r2"

import {
  insertDispute,
  insertLedgerEntry,
  insertLiveLaunch,
  insertMatch,
  insertOrder,
  insertPortfolioItem,
  insertSocialConnection,
  insertStripeAccount,
  insertTransfer,
  insertUser,
} from "../../helpers/db-fixtures"
import { setupTestDatabase } from "../../helpers/db"
import { stubServiceEnv } from "../../helpers/service-env"
import { acceptedCollab } from "../collabs/helpers"
import {
  authUserOf,
  makeTempDataDir,
  onboardedBuilder,
  openIdea,
  removeTempDataDir,
  terms,
} from "../proposals/helpers"

/**
 * GDPR (§14; CLAUDE.md §19.38, §19.40): the data export (complete, no tokens, no other people's
 * personal data), the deletion blockers, the anonymising deletion (keeps ledger and orders), and
 * the delete action (email, storage cleanup, sign-out).
 */

const mocks = vi.hoisted(() => ({
  dir: "",
  db: null as unknown,
  user: null as AuthUser | null,
  signOut: null as null | ((options?: unknown) => Promise<void>),
}))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(mocks.dir, ...segments) }
})
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => mocks.db }
})
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => {
    if (!mocks.user) throw new Error("no user")
    return mocks.user
  },
}))
vi.mock("@/lib/auth/auth", () => ({
  signOut: async (options?: unknown) => mocks.signOut?.(options),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const { deleteAccountAction } = await import("@/lib/gdpr/actions")

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-06T12:00:00.000Z")
const BUYER_EMAIL = "buyer-secret@example.test"
const TOKEN_CIPHER = "v1:token-ciphertext-must-never-leave"

beforeAll(async () => {
  mocks.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(mocks.dir)
})
beforeEach(() => {
  mocks.db = testDb.db
  mocks.user = null
  mocks.signOut = null
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(async () => {
  setClockForTests(null)
  await closeDb()
})

async function endCollab(db: Db, collabId: string) {
  await db
    .update(collabs)
    .set({ stage: "ended", endedAt: NOW, endedReason: "completed" })
    .where(eq(collabs.id, collabId))
}

/**
 * A creator with an ended collab (signed agreement, messages both ways), an open idea with a
 * pending proposal from another builder, an unused draft idea, social data, notifications, a
 * match, saved items, sessions, a Stripe account with a stored event, and a purchase made with
 * their own email.
 */
async function richCreator(db: Db) {
  const { creator, builder, collabId, agreement, idea: collabIdea } = await acceptedCollab(db)
  await endCollab(db, collabId)
  await db.insert(agreementSignatures).values({
    agreementId: agreement.id,
    userId: creator.user.id,
    signedAt: NOW,
    ip: "203.0.113.5",
    userAgent: "Test Browser",
    typedName: "Ada Creator",
    bodyHash: agreement.bodyHash,
  })
  const [thread] = await db.select().from(threads).where(eq(threads.collabId, collabId))
  if (!thread) throw new Error("no thread")
  await db.insert(messages).values([
    {
      threadId: thread.id,
      authorUserId: creator.user.id,
      body: "Here are my notes for the launch.",
      attachments: [
        {
          storageKey: `message-attachments/${thread.id}/notes.pdf`,
          filename: "notes.pdf",
          contentType: "application/pdf",
          sizeBytes: 10,
        },
      ],
    },
    { threadId: thread.id, authorUserId: builder.user.id, body: "Builder private reply text." },
  ])

  // Another builder pitches on a second, open idea (stays pending).
  const otherBuilder = await onboardedBuilder(db)
  const openOne = await openIdea(db, creator, "Meal planner")
  const { proposalId } = await sendProposal(db, otherBuilder.auth, {
    recipientId: creator.user.id,
    target: { kind: "idea", id: openOne.id },
    matchId: null,
    terms: terms(),
  })
  const [draft] = await db
    .insert(ideas)
    .values({ creatorProfileId: creator.profile.id, title: "Unused draft", format: "tool" })
    .returning()
  if (!draft) throw new Error("no draft")

  const connection = await insertSocialConnection(db, creator.user.id, {
    accessTokenEnc: TOKEN_CIPHER,
    refreshTokenEnc: TOKEN_CIPHER,
  })
  await db.insert(audienceSnapshots).values({
    socialConnectionId: connection.id,
    takenAt: NOW,
    followers: 48200,
  })
  const manual = await insertSocialConnection(db, creator.user.id, {
    provider: "instagram",
    source: "manual",
    evidenceStorageKey: `social-evidence/${creator.user.id}/instagram-1.png`,
  })

  await db.insert(notifications).values({
    userId: creator.user.id,
    type: "payouts.ready",
    payload: { stripe_account_id: "acct_test_1" },
  })
  await db.insert(notificationPrefs).values({ userId: creator.user.id, type: "proposal.received" })
  await db
    .insert(savedItems)
    .values({ userId: creator.user.id, targetType: "builder", targetId: builder.user.id })
  const ownMatch = await insertMatch(db, {
    subjectUserId: creator.user.id,
    targetType: "builder",
    targetId: builder.user.id,
  })
  const theirMatch = await insertMatch(db, {
    subjectUserId: builder.user.id,
    targetType: "creator",
    targetId: creator.user.id,
  })
  await db.insert(sessions).values({
    sessionToken: `session-${creator.user.id}`,
    userId: creator.user.id,
    expires: new Date("2027-01-01T00:00:00Z"),
  })
  await db.insert(accounts).values({
    userId: creator.user.id,
    type: "oauth",
    provider: "github",
    providerAccountId: `gh-${creator.user.id}`,
  })
  const stripeAccount = await insertStripeAccount(db, creator.user.id)
  await db.insert(stripeEvents).values({
    id: `evt_${creator.user.id}`,
    type: "account.updated",
    account: stripeAccount.stripeAccountId,
    payload: {
      data: { object: { email: "connected@example.test", id: stripeAccount.stripeAccountId } },
    },
  })

  // A purchase made with the creator's own email, and a sale of someone else's launch.
  const other = await insertLiveLaunch(db)
  const purchase = await insertOrder(db, other.launch.id, NOW, {
    buyerEmail: creator.user.email ?? "",
  })

  return {
    creator,
    builder,
    otherBuilder,
    collabId,
    collabIdea,
    agreement,
    openOne,
    draft,
    proposalId,
    connection,
    manual,
    ownMatch,
    theirMatch,
    purchase,
  }
}

describe("buildDataExport", () => {
  it("lists every section and leaves out tokens and other people's data", async () => {
    const scenario = await richCreator(testDb.db)
    const data = await buildDataExport(testDb.db, {
      userId: scenario.creator.user.id,
      now: NOW,
      appName: "Vincera",
    })
    for (const section of DATA_EXPORT_SECTIONS) expect(data).toHaveProperty(section)
    const json = JSON.stringify(data)
    expect(json).not.toContain(TOKEN_CIPHER)
    expect(json).not.toContain("Builder private reply text.")
    expect(json).not.toContain(scenario.builder.user.email ?? "@@")
    expect(json).not.toContain(scenario.otherBuilder.user.email ?? "@@")
    expect(json).not.toContain("instagram-1.png")
    expect(json).not.toMatch(/"embedding"/)

    expect(data.account).toMatchObject({
      id: scenario.creator.user.id,
      email: scenario.creator.user.email,
    })
    expect(data.messages).toEqual([
      expect.objectContaining({
        body: "Here are my notes for the launch.",
        attachmentNames: ["notes.pdf"],
      }),
    ])
    expect(data.socialConnections).toHaveLength(2)
    expect(data.audienceSnapshots).toEqual([expect.objectContaining({ followers: 48200 })])
    expect(data.ideas).toHaveLength(3)
    expect(data.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: scenario.proposalId,
          yourSide: "recipient",
          counterpartUserId: scenario.otherBuilder.user.id,
        }),
      ]),
    )
    // The creator authored no revision (the builders proposed).
    expect(data.proposalRevisions).toEqual([])
    expect(data.collabs).toEqual([
      expect.objectContaining({
        collabId: scenario.collabId,
        role: "creator",
        otherMembers: [{ userId: scenario.builder.user.id, role: "builder", splitPct: 40 }],
      }),
    ])
    expect(data.agreements).toEqual([
      expect.objectContaining({
        id: scenario.agreement.id,
        yourSignature: expect.objectContaining({ typedName: "Ada Creator" }),
      }),
    ])
    expect(data.purchases).toEqual([
      expect.objectContaining({ orderId: scenario.purchase.id, amountGrossCents: 1900 }),
    ])
    expect(data.matches).toEqual([expect.objectContaining({ id: scenario.ownMatch.id })])
    expect(data.notifications).toContainEqual(expect.objectContaining({ type: "payouts.ready" }))
  })

  it("lists sales as amounts without buyer emails", async () => {
    const { launch, creator } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, NOW, { buyerEmail: BUYER_EMAIL })
    await insertLedgerEntry(testDb.db, {
      account: "creator_share",
      amountCents: 900,
      userId: creator.user.id,
      orderId: order.id,
    })
    const data = await buildDataExport(testDb.db, {
      userId: creator.user.id,
      now: NOW,
      appName: "Vincera",
    })
    expect(data.sales).toEqual([expect.objectContaining({ id: order.id, amountGrossCents: 1900 })])
    expect(data.ledgerEntries).toEqual([expect.objectContaining({ amountCents: 900 })])
    expect(JSON.stringify(data)).not.toContain(BUYER_EMAIL)
  })
})

describe("dataExportResponse", () => {
  it("downloads JSON, records the event, and is rate limited", async () => {
    const user = await insertUser(testDb.db, { roles: ["creator"] })
    const response = await dataExportResponse({
      db: testDb.db,
      user: authUserOf(user),
      appName: "Vincera",
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="vincera-data-2026-10-06.json"',
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = (await response.json()) as { userId: string; format: string }
    expect(body).toMatchObject({ userId: user.id, format: "json" })
    const recorded = await testDb.db
      .select()
      .from(events)
      .where(and(eq(events.subjectId, user.id), eq(events.type, "user.data_exported")))
    expect(recorded).toHaveLength(1)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await dataExportResponse({ db: testDb.db, user: authUserOf(user), appName: "Vincera" })
    }
    const limited = await dataExportResponse({
      db: testDb.db,
      user: authUserOf(user),
      appName: "Vincera",
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBeTruthy()
  })

  it("sends signed-out visitors to sign in and refuses suspended accounts", async () => {
    const signedOut = await dataExportResponse({ db: testDb.db, user: null, appName: "Vincera" })
    expect(signedOut.status).toBe(303)
    expect(signedOut.headers.get("location")).toContain("/sign-in")
    const suspended = await insertUser(testDb.db, { status: "suspended" })
    const refused = await dataExportResponse({
      db: testDb.db,
      user: authUserOf(suspended),
      appName: "Vincera",
    })
    expect(refused.status).toBe(403)
  })

  it("names the file after the app", () => {
    expect(dataExportFilename("My App!", NOW)).toBe("my-app-data-2026-10-06.json")
  })
})

describe("accountDeletionBlockers", () => {
  it("blocks while a collab is active or a dispute is open", async () => {
    const { creator, builder, collabId } = await acceptedCollab(testDb.db)
    expect(await accountDeletionBlockers(testDb.db, creator.user.id)).toEqual(["active_collabs"])
    await endCollab(testDb.db, collabId)
    expect(await accountDeletionBlockers(testDb.db, creator.user.id)).toEqual([])
    await insertDispute(testDb.db, collabId, builder.user.id)
    expect(await accountDeletionBlockers(testDb.db, creator.user.id)).toEqual(["open_disputes"])
  })

  it("blocks on an untransferred balance (either sign) and a pending transfer", async () => {
    const user = await insertUser(testDb.db, { roles: ["creator"] })
    const { launch } = await insertLiveLaunch(testDb.db)
    const order = await insertOrder(testDb.db, launch.id, NOW)
    await insertLedgerEntry(testDb.db, {
      account: "adjustment",
      amountCents: -500,
      userId: user.id,
      orderId: order.id,
    })
    expect(await accountDeletionBlockers(testDb.db, user.id)).toEqual(["unpaid_balance"])
    await insertLedgerEntry(testDb.db, {
      account: "adjustment",
      amountCents: 500,
      userId: user.id,
      orderId: order.id,
    })
    expect(await accountDeletionBlockers(testDb.db, user.id)).toEqual([])
    // Paid out already: no balance left.
    const paid = await insertTransfer(testDb.db, user.id, {
      status: "created",
      stripeTransferId: `tr_test_${randomUUID()}`,
    })
    await insertLedgerEntry(testDb.db, {
      account: "creator_share",
      amountCents: 1000,
      userId: user.id,
      orderId: order.id,
      transferId: paid.id,
    })
    expect(await accountDeletionBlockers(testDb.db, user.id)).toEqual([])
    await insertTransfer(testDb.db, user.id)
    expect(await accountDeletionBlockers(testDb.db, user.id)).toEqual(["pending_transfer"])
  })
})

describe("deleteAccount", () => {
  it("refuses while blocked, and for admins", async () => {
    const { creator } = await acceptedCollab(testDb.db)
    await expect(
      deleteAccount(testDb.db, { userId: creator.user.id, now: NOW }),
    ).rejects.toBeInstanceOf(AccountDeletionBlockedError)
    const admin = await insertUser(testDb.db, { roles: ["admin"] })
    await expect(deleteAccount(testDb.db, { userId: admin.id, now: NOW })).rejects.toThrow(
      /Admin accounts/,
    )
  })

  it("anonymises the account and keeps the ledger, orders and agreement", async () => {
    const scenario = await richCreator(testDb.db)
    const userId = scenario.creator.user.id
    const oldEmail = scenario.creator.user.email
    const [oldProfile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, userId))

    const result = await deleteAccount(testDb.db, { userId, now: NOW })
    expect(result.email).toBe(oldEmail)
    expect(result.storageKeys).toEqual(
      expect.arrayContaining([
        `social-evidence/${userId}/instagram-1.png`,
        expect.stringMatching(/^message-attachments\/.+\/notes\.pdf$/),
      ]),
    )

    const [user] = await testDb.db.select().from(users).where(eq(users.id, userId))
    expect(user).toMatchObject({
      email: null,
      name: null,
      image: null,
      status: "suspended",
      deletedAt: NOW,
      onboardingSteps: {},
    })

    // Profile kept, anonymised, on a fresh handle; the old handle is free.
    const [profile] = await testDb.db
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, userId))
    expect(profile?.displayName).toBe(DELETED_DISPLAY_NAME)
    expect(profile?.handle).toMatch(/^deleted_[0-9a-f]{12}$/)
    expect(profile?.bio).toBeNull()
    const oldHandle = await testDb.db
      .select()
      .from(handles)
      .where(eq(handles.handle, oldProfile?.handle ?? ""))
    expect(oldHandle).toEqual([])

    // Sign-in, social and personal rows gone.
    expect(await testDb.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([])
    expect(await testDb.db.select().from(accounts).where(eq(accounts.userId, userId))).toEqual([])
    expect(
      await testDb.db.select().from(socialConnections).where(eq(socialConnections.userId, userId)),
    ).toEqual([])
    expect(
      await testDb.db
        .select()
        .from(audienceSnapshots)
        .where(eq(audienceSnapshots.socialConnectionId, scenario.connection.id)),
    ).toEqual([])
    expect(
      await testDb.db.select().from(notifications).where(eq(notifications.userId, userId)),
    ).toEqual([])
    expect(
      await testDb.db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId)),
    ).toEqual([])
    expect(await testDb.db.select().from(savedItems).where(eq(savedItems.userId, userId))).toEqual(
      [],
    )

    // Messages redacted; the collaborator's messages untouched.
    const own = await testDb.db.select().from(messages).where(eq(messages.authorUserId, userId))
    expect(own).toEqual([expect.objectContaining({ body: DELETED_MESSAGE_BODY, attachments: [] })])
    const theirs = await testDb.db
      .select()
      .from(messages)
      .where(eq(messages.authorUserId, scenario.builder.user.id))
    expect(theirs[0]?.body).toBe("Builder private reply text.")

    // Signature: IP and browser gone, typed name and time kept.
    const [signature] = await testDb.db
      .select()
      .from(agreementSignatures)
      .where(eq(agreementSignatures.userId, userId))
    expect(signature).toMatchObject({ ip: null, userAgent: null, typedName: "Ada Creator" })

    // Ideas: the unused draft is deleted, the open one archived, the collab's one kept.
    const remaining = await testDb.db
      .select({ id: ideas.id, status: ideas.status })
      .from(ideas)
      .where(eq(ideas.creatorProfileId, scenario.creator.profile.id))
    expect(remaining).toEqual(
      expect.arrayContaining([
        { id: scenario.openOne.id, status: "archived" },
        { id: scenario.collabIdea.id, status: "in_collab" },
      ]),
    )
    expect(remaining.some((idea) => idea.id === scenario.draft.id)).toBe(false)

    // The pending proposal to them is declined.
    const [proposal] = await testDb.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, scenario.proposalId))
    expect(proposal).toMatchObject({ status: "declined", closedAt: NOW })

    // Matches as subject and as target left the lists, but stay.
    const staled = await testDb.db
      .select({ id: matches.id, staleAt: matches.staleAt })
      .from(matches)
      .where(eq(matches.targetId, userId))
    expect(staled).toEqual([{ id: scenario.theirMatch.id, staleAt: NOW }])

    // Stripe event payload redacted.
    const [stripeEvent] = await testDb.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, `evt_${userId}`))
    expect(JSON.stringify(stripeEvent?.payload)).not.toContain("connected@example.test")

    // The purchase (a tax record) keeps its buyer email.
    const [purchase] = await testDb.db
      .select()
      .from(orders)
      .where(eq(orders.id, scenario.purchase.id))
    expect(purchase?.buyerEmail).toBe(oldEmail)

    const deleted = await testDb.db
      .select()
      .from(events)
      .where(and(eq(events.subjectId, userId), eq(events.type, "user.deleted")))
    expect(deleted).toEqual([
      expect.objectContaining({ actorUserId: userId, properties: { roles: ["creator"] } }),
    ])

    await expect(deleteAccount(testDb.db, { userId, now: NOW })).rejects.toThrow(/no longer exists/)
  })

  it("keeps revisions' terms but clears the deleted author's message", async () => {
    const { builder, creator, collabId } = await acceptedCollab(testDb.db)
    await endCollab(testDb.db, collabId)
    const before = await testDb.db
      .select()
      .from(proposalRevisions)
      .where(eq(proposalRevisions.authorUserId, builder.user.id))
    expect(before[0]?.message).toBeTruthy()
    // The creator is paid out and has nothing pending.
    await deleteAccount(testDb.db, { userId: builder.user.id, now: NOW })
    const after = await testDb.db
      .select()
      .from(proposalRevisions)
      .where(eq(proposalRevisions.authorUserId, builder.user.id))
    expect(after[0]).toMatchObject({ message: null, scope: before[0]?.scope })
    // The ledger and orders of other people are untouched by construction; the creator remains.
    const [stillThere] = await testDb.db.select().from(users).where(eq(users.id, creator.user.id))
    expect(stillThere?.email).toBe(creator.user.email)
  })

  it("keeps ledger entries and orders of a seller", async () => {
    const { launch, creator, collab } = await insertLiveLaunch(testDb.db)
    await endCollab(testDb.db, collab.id)
    const order = await insertOrder(testDb.db, launch.id, NOW, { buyerEmail: BUYER_EMAIL })
    const transfer = await insertTransfer(testDb.db, creator.user.id, {
      status: "created",
      stripeTransferId: `tr_test_${randomUUID()}`,
    })
    await insertLedgerEntry(testDb.db, {
      account: "creator_share",
      amountCents: 900,
      userId: creator.user.id,
      orderId: order.id,
      transferId: transfer.id,
    })
    await deleteAccount(testDb.db, { userId: creator.user.id, now: NOW })
    const entries = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, creator.user.id))
    expect(entries).toEqual([
      expect.objectContaining({ amountCents: 900, transferId: transfer.id }),
    ])
    const [kept] = await testDb.db.select().from(orders).where(eq(orders.id, order.id))
    expect(kept?.buyerEmail).toBe(BUYER_EMAIL)
  })
})

describe("deleteAccountAction", () => {
  it("needs the typed confirmation, then deletes, emails, cleans storage and signs out", async () => {
    const builder = await onboardedBuilder(testDb.db)
    const storage = getStorage()
    const imageKey = `portfolio-images/${builder.user.id}/0190f5e4-0000-7000-8000-000000000001.png`
    await storage.putObject(imageKey, Buffer.from("png"), "image/png")
    await insertPortfolioItem(testDb.db, builder.profile.id, { imageUrl: imageKey })
    const signedOut = vi.fn(async () => undefined)
    mocks.signOut = signedOut
    mocks.user = authUserOf(builder.user)

    const wrong = await deleteAccountAction({ confirmation: "delete me" })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.fieldErrors?.confirmation?.[0]).toMatch(/Type DELETE/)
    expect(signedOut).not.toHaveBeenCalled()

    const result = await deleteAccountAction({ confirmation: " DELETE " })
    expect(result.ok).toBe(true)
    expect(signedOut).toHaveBeenCalledWith({ redirectTo: "/?account=deleted" })

    const [user] = await testDb.db.select().from(users).where(eq(users.id, builder.user.id))
    expect(user?.deletedAt).toEqual(NOW)
    const [profile] = await testDb.db
      .select()
      .from(builderProfiles)
      .where(eq(builderProfiles.userId, builder.user.id))
    expect(profile).toMatchObject({
      displayName: DELETED_DISPLAY_NAME,
      skills: [],
      availability: "closed",
    })
    expect(
      await testDb.db
        .select()
        .from(portfolioItems)
        .where(eq(portfolioItems.builderProfileId, builder.profile.id)),
    ).toEqual([])
    expect(await storage.statObject(imageKey)).toBeNull()

    const outbox = await listOutbox()
    expect(
      outbox.some(
        (email) =>
          email.to.includes(builder.user.email ?? "") && /account was deleted/.test(email.subject),
      ),
    ).toBe(true)
  })

  it("refuses admins and shows the blockers", async () => {
    const admin = await insertUser(testDb.db, { roles: ["admin"] })
    mocks.user = authUserOf(admin)
    const refused = await deleteAccountAction({ confirmation: "DELETE" })
    expect(refused.ok).toBe(false)

    const { creator } = await acceptedCollab(testDb.db)
    mocks.user = creator.auth
    const blocked = await deleteAccountAction({ confirmation: "DELETE" })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toMatch(/collab that hasn't ended/)
  })
})

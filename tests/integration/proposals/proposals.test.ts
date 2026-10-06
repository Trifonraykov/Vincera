import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { findJob } from "@/inngest/functions"
import { ActionError } from "@/lib/actions/errors"
import { setClockForTests } from "@/lib/clock"
import {
  collabMembers,
  collabs,
  ideas,
  matches,
  proposalRevisions,
  proposals,
  threadReads,
  threads,
  users,
} from "@/lib/db/schema"
import { listOutbox } from "@/lib/email/outbox"
import { expireDueProposals } from "@/lib/proposals/expire"
import {
  countProposalTabs,
  listProposals,
  proposalCursorAfter,
  listProposalsAwaitingUser,
  loadProposalDetail,
} from "@/lib/proposals/queries"
import {
  acceptProposal,
  counterProposal,
  declineProposal,
  PROPOSAL_MESSAGES,
  sendProposal,
  withdrawProposal,
} from "@/lib/proposals/service"
import { resetMemoryRateLimits } from "@/lib/ratelimit"

import { setupTestDatabase } from "../../helpers/db"
import { insertMatch } from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  eventsOf,
  makeTempDataDir,
  notificationsOf,
  onboardedBuilder,
  onboardedCreator,
  openIdea,
  removeTempDataDir,
  seekingProduct,
  terms,
  type Person,
} from "./helpers"

/**
 * The proposal state machine against Postgres (CLAUDE.md §19.24 "Proposals"): send, counter,
 * accept, decline, withdraw and expire, with their revisions, events, notifications and emails,
 * the daily limit, and who may do what.
 */

const dataRoot = vi.hoisted(() => ({ dir: "", db: null as unknown }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(dataRoot.dir, ...segments) }
})
// The job resolves the app's database itself; point it at this file's database.
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>()
  return { ...original, getDb: () => dataRoot.db }
})

const testDb = setupTestDatabase()
const NOW = new Date("2026-10-05T12:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000

beforeAll(async () => {
  dataRoot.dir = await makeTempDataDir()
})
afterAll(async () => {
  await removeTempDataDir(dataRoot.dir)
})
beforeEach(() => {
  dataRoot.db = testDb.db
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(() => setClockForTests(null))

async function emailsTo(person: Person) {
  const email = person.user.email
  return (await listOutbox()).filter((message) => email && message.to.includes(email))
}

/** A builder pitching on a creator's open idea. */
async function pitch(options: { creatorSplitPct?: number } = {}) {
  const creator = await onboardedCreator(testDb.db)
  const builder = await onboardedBuilder(testDb.db)
  const idea = await openIdea(testDb.db, creator)
  const sent = await sendProposal(testDb.db, builder.auth, {
    recipientId: creator.user.id,
    target: { kind: "idea", id: idea.id },
    matchId: null,
    terms: terms({
      creatorSplitPct: options.creatorSplitPct ?? 60,
      builderSplitPct: 100 - (options.creatorSplitPct ?? 60),
    }),
  })
  return { creator, builder, idea, ...sent }
}

async function proposalRow(id: string) {
  const [row] = await testDb.db.select().from(proposals).where(eq(proposals.id, id))
  if (!row) throw new Error("no proposal")
  return row
}

async function rejectsWith(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(ActionError)
  await expect(promise).rejects.toThrow(message)
}

describe("sendProposal", () => {
  it("stores the proposal, revision 1, the thread, proposal.sent, and notifies the recipient", async () => {
    const { creator, builder, idea, proposalId, threadId, revisionId } = await pitch()

    const row = await proposalRow(proposalId)
    expect(row).toMatchObject({
      fromUserId: builder.user.id,
      toUserId: creator.user.id,
      ideaId: idea.id,
      productId: null,
      status: "pending",
      currentRevisionId: revisionId,
      respondedAt: null,
      closedAt: null,
      matchId: null,
    })
    expect(row.createdAt).toEqual(NOW)
    expect(row.expiresAt).toEqual(new Date(NOW.getTime() + 14 * DAY))

    const revisions = await testDb.db
      .select()
      .from(proposalRevisions)
      .where(eq(proposalRevisions.proposalId, proposalId))
    expect(revisions).toEqual([
      expect.objectContaining({
        id: revisionId,
        revisionNumber: 1,
        authorUserId: builder.user.id,
        creatorSplitPct: 60,
        builderSplitPct: 40,
        timelineWeeks: 6,
        scope: terms().scope,
        message: terms().message,
      }),
    ])

    const [thread] = await testDb.db.select().from(threads).where(eq(threads.id, threadId))
    expect(thread).toMatchObject({ kind: "proposal", proposalId, lastMessageAt: null })
    const reads = await testDb.db
      .select()
      .from(threadReads)
      .where(eq(threadReads.threadId, threadId))
    expect(reads.map((read) => read.userId).sort()).toEqual(
      [builder.user.id, creator.user.id].sort(),
    )

    const sent = await eventsOf(testDb.db, proposalId, "proposal.sent")
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ actorUserId: builder.user.id, subjectType: "proposal" })
    expect(sent[0]?.properties).toEqual({
      revision_number: 1,
      creator_split_pct: 60,
      builder_split_pct: 40,
      timeline_weeks: 6,
      to_user_id: creator.user.id,
      target: "idea",
      target_id: idea.id,
      match_id: null,
    })

    const received = await notificationsOf(testDb.db, creator.user.id, "proposal.received")
    expect(received).toHaveLength(1)
    expect(received[0]?.payload).toEqual({
      proposal_id: proposalId,
      counterpart_name: builder.profile.displayName,
      target_kind: "idea",
      target_title: idea.title,
    })
    expect(await notificationsOf(testDb.db, builder.user.id)).toHaveLength(0)
    const emails = await emailsTo(creator)
    expect(emails.map((email) => email.subject)).toContain(
      `${builder.profile.displayName} sent you a proposal`,
    )
    // The email shows the numbers, not the sender's message.
    const email = emails.find((message) => message.subject.endsWith("sent you a proposal"))
    expect(email?.text).toContain("60%")
    expect(email?.text).not.toContain(terms().message ?? "")
  })

  it("lets a creator pitch on a builder's product, and links the sender's own match", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const product = await seekingProduct(testDb.db, builder)
    const match = await insertMatch(testDb.db, {
      subjectUserId: creator.user.id,
      targetType: "product",
      targetId: product.id,
    })
    const others = await insertMatch(testDb.db, {
      subjectUserId: builder.user.id,
      targetType: "creator",
      targetId: creator.user.id,
    })

    const { proposalId } = await sendProposal(testDb.db, creator.auth, {
      recipientId: builder.user.id,
      target: { kind: "product", id: product.id },
      matchId: match.id,
      terms: terms(),
    })
    expect((await proposalRow(proposalId)).matchId).toBe(match.id)
    const [linked] = await testDb.db.select().from(matches).where(eq(matches.id, match.id))
    expect(linked?.status).toBe("proposed")

    // Someone else's match is never linked (nor marked).
    const second = await seekingProduct(testDb.db, builder)
    const { proposalId: other } = await sendProposal(testDb.db, creator.auth, {
      recipientId: builder.user.id,
      target: { kind: "product", id: second.id },
      matchId: others.id,
      terms: terms(),
    })
    expect((await proposalRow(other)).matchId).toBeNull()
    const [untouched] = await testDb.db.select().from(matches).where(eq(matches.id, others.id))
    expect(untouched?.status).toBe("shown")
  })

  it("refuses what canSendProposal refuses, in plain language", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const idea = await openIdea(testDb.db, creator)
    const send = (sender: Person, recipientId: string, ideaId = idea.id) =>
      sendProposal(testDb.db, sender.auth, {
        recipientId,
        target: { kind: "idea", id: ideaId },
        matchId: null,
        terms: terms(),
      })

    await rejectsWith(send(builder, builder.user.id), "You can't send a proposal to yourself.")
    // A creator cannot pitch on another creator's idea (ideas are offered to builders).
    const otherCreator = await onboardedCreator(testDb.db)
    await rejectsWith(send(otherCreator, creator.user.id), "Add the builder role")
    // Not onboarded yet.
    await testDb.db
      .update(users)
      .set({ onboardingCompletedAt: null })
      .where(eq(users.id, builder.user.id))
    await rejectsWith(
      send({ ...builder, auth: { ...builder.auth, onboardingCompletedAt: null } }, creator.user.id),
      "Finish setting up your account",
    )
    // A suspended recipient.
    const suspended = await onboardedCreator(testDb.db)
    const theirIdea = await openIdea(testDb.db, suspended)
    await testDb.db
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.id, suspended.user.id))
    const builder2 = await onboardedBuilder(testDb.db)
    await rejectsWith(send(builder2, suspended.user.id, theirIdea.id), "isn't taking proposals")
    // A draft idea, and an idea that is not the recipient's.
    const draft = await openIdea(testDb.db, creator)
    await testDb.db
      .update(ideas)
      .set({ status: "archived", archivedAt: NOW })
      .where(eq(ideas.id, draft.id))
    await rejectsWith(send(builder2, creator.user.id, draft.id), "This idea isn't open")
    await rejectsWith(send(builder2, otherCreator.user.id), "belongs to someone else")
    // Unknown target.
    await rejectsWith(
      send(builder2, creator.user.id, "0190a000-0000-7000-8000-00000000abcd"),
      PROPOSAL_MESSAGES.targetNotFound,
    )
    const involved = [creator, builder, otherCreator, suspended, builder2].map((p) => p.user.id)
    const stored = await testDb.db.select().from(proposals)
    expect(stored.filter((row) => involved.includes(row.fromUserId))).toHaveLength(0)
  })

  it("allows one open proposal per pair and target, in either direction", async () => {
    const { creator, builder, idea, proposalId } = await pitch()
    await rejectsWith(
      sendProposal(testDb.db, builder.auth, {
        recipientId: creator.user.id,
        target: { kind: "idea", id: idea.id },
        matchId: null,
        terms: terms(),
      }),
      PROPOSAL_MESSAGES.duplicate,
    )
    // The creator offering the same idea back to the builder is the same pair and target.
    await rejectsWith(
      sendProposal(testDb.db, creator.auth, {
        recipientId: builder.user.id,
        target: { kind: "idea", id: idea.id },
        matchId: null,
        terms: terms(),
      }),
      PROPOSAL_MESSAGES.duplicate,
    )
    // Once it is closed, a new one may be sent.
    await declineProposal(testDb.db, creator.auth, { proposalId })
    await expect(
      sendProposal(testDb.db, builder.auth, {
        recipientId: creator.user.id,
        target: { kind: "idea", id: idea.id },
        matchId: null,
        terms: terms(),
      }),
    ).resolves.toMatchObject({ proposalId: expect.any(String) })
  })

  it("keeps one when two identical sends race past the check (the unique index)", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const idea = await openIdea(testDb.db, creator)
    const input = {
      recipientId: creator.user.id,
      target: { kind: "idea" as const, id: idea.id },
      matchId: null,
      terms: terms(),
    }
    const results = await Promise.allSettled([
      sendProposal(testDb.db, builder.auth, input),
      sendProposal(testDb.db, builder.auth, input),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status === "rejected" && String(rejected.reason)).toContain(
      PROPOSAL_MESSAGES.duplicate,
    )
  })

  it("limits new proposals to 20 a day per sender; counters are not limited", async () => {
    const builder = await onboardedBuilder(testDb.db)
    const creator = await onboardedCreator(testDb.db)
    const ideaIds: string[] = []
    for (let index = 0; index < 21; index++) {
      ideaIds.push((await openIdea(testDb.db, creator, `Idea ${index}`)).id)
    }
    const send = (ideaId: string) =>
      sendProposal(testDb.db, builder.auth, {
        recipientId: creator.user.id,
        target: { kind: "idea", id: ideaId },
        matchId: null,
        terms: terms(),
      })
    const sent: string[] = []
    for (const ideaId of ideaIds.slice(0, 20)) sent.push((await send(ideaId)).proposalId)
    await rejectsWith(send(ideaIds[20] ?? ""), PROPOSAL_MESSAGES.rateLimited)

    // The creator counters and the builder counters back: not new proposals.
    const first = sent[0] ?? ""
    const detail = await loadProposalDetail(testDb.db, first)
    const countered = await counterProposal(testDb.db, creator.auth, {
      proposalId: first,
      revisionId: detail?.currentRevisionId ?? "",
      terms: terms({ creatorSplitPct: 70, builderSplitPct: 30 }),
    })
    await expect(
      counterProposal(testDb.db, builder.auth, {
        proposalId: first,
        revisionId: countered.revisionId,
        terms: terms({ creatorSplitPct: 65, builderSplitPct: 35 }),
      }),
    ).resolves.toMatchObject({ revisionNumber: 3 })

    // A day later the limit has room again.
    setClockForTests(new Date(NOW.getTime() + DAY + 1000))
    await expect(send(ideaIds[20] ?? "")).resolves.toMatchObject({ proposalId: expect.any(String) })
  })
})

describe("counterProposal", () => {
  it("adds the next revision, resets the expiry, records the first answer and notifies", async () => {
    const { creator, builder, proposalId, revisionId } = await pitch()
    const later = new Date(NOW.getTime() + 3 * DAY)
    setClockForTests(later)

    const result = await counterProposal(testDb.db, creator.auth, {
      proposalId,
      revisionId,
      terms: terms({ creatorSplitPct: 70, builderSplitPct: 30, timelineWeeks: 8, message: null }),
    })
    expect(result.revisionNumber).toBe(2)
    const row = await proposalRow(proposalId)
    expect(row).toMatchObject({
      status: "countered",
      currentRevisionId: result.revisionId,
      respondedAt: later,
      closedAt: null,
    })
    expect(row.expiresAt).toEqual(new Date(later.getTime() + 14 * DAY))

    const [event] = await eventsOf(testDb.db, proposalId, "proposal.countered")
    expect(event).toMatchObject({ actorUserId: creator.user.id })
    expect(event?.properties).toEqual({
      revision_number: 2,
      creator_split_pct: 70,
      builder_split_pct: 30,
      timeline_weeks: 8,
    })
    const [notice] = await notificationsOf(testDb.db, builder.user.id, "proposal.countered")
    expect(notice?.payload).toMatchObject({
      proposal_id: proposalId,
      counterpart_name: creator.profile.displayName,
      revision_number: 2,
    })
    expect((await emailsTo(builder)).map((email) => email.subject)).toContain(
      `${creator.profile.displayName} countered your proposal`,
    )

    // The builder counters back; responded_at keeps the recipient's first answer.
    setClockForTests(new Date(later.getTime() + DAY))
    const third = await counterProposal(testDb.db, builder.auth, {
      proposalId,
      revisionId: result.revisionId,
      terms: terms({ creatorSplitPct: 65, builderSplitPct: 35 }),
    })
    expect(third.revisionNumber).toBe(3)
    expect((await proposalRow(proposalId)).respondedAt).toEqual(later)
  })

  it("refuses your own offer, a stale offer, non-parties and closed proposals", async () => {
    const { creator, builder, proposalId, revisionId } = await pitch()
    await rejectsWith(
      counterProposal(testDb.db, builder.auth, { proposalId, revisionId, terms: terms() }),
      PROPOSAL_MESSAGES.ownOffer,
    )
    const stranger = await onboardedBuilder(testDb.db)
    await rejectsWith(
      counterProposal(testDb.db, stranger.auth, { proposalId, revisionId, terms: terms() }),
      PROPOSAL_MESSAGES.notFound,
    )
    const countered = await counterProposal(testDb.db, creator.auth, {
      proposalId,
      revisionId,
      terms: terms({ creatorSplitPct: 70, builderSplitPct: 30 }),
    })
    // The builder answers the counter-offer, but from a page that still shows revision 1.
    await rejectsWith(
      counterProposal(testDb.db, builder.auth, { proposalId, revisionId, terms: terms() }),
      PROPOSAL_MESSAGES.stale,
    )
    await declineProposal(testDb.db, builder.auth, {
      proposalId,
      revisionId: countered.revisionId,
    })
    await rejectsWith(
      counterProposal(testDb.db, creator.auth, {
        proposalId,
        revisionId: countered.revisionId,
        terms: terms(),
      }),
      PROPOSAL_MESSAGES.closed.declined,
    )
  })

  it("refuses a counter once the idea is no longer open", async () => {
    const { creator, idea, proposalId, revisionId } = await pitch()
    await testDb.db
      .update(ideas)
      .set({ status: "archived", archivedAt: NOW })
      .where(eq(ideas.id, idea.id))
    await rejectsWith(
      counterProposal(testDb.db, creator.auth, { proposalId, revisionId, terms: terms() }),
      "This idea isn't open for proposals any more",
    )
  })
})

describe("acceptProposal", () => {
  it("accepts the latest offer and creates the collab with its terms, in one transaction", async () => {
    const { creator, builder, idea, proposalId, revisionId } = await pitch()
    const countered = await counterProposal(testDb.db, creator.auth, {
      proposalId,
      revisionId,
      terms: terms({ creatorSplitPct: 70, builderSplitPct: 30, timelineWeeks: 8 }),
    })
    const later = new Date(NOW.getTime() + DAY)
    setClockForTests(later)

    // The creator cannot accept their own counter-offer; the builder can.
    await rejectsWith(
      acceptProposal(testDb.db, creator.auth, { proposalId, revisionId: countered.revisionId }),
      PROPOSAL_MESSAGES.ownOffer,
    )
    // Accepting the offer the builder no longer sees (revision 1) is refused.
    await rejectsWith(
      acceptProposal(testDb.db, builder.auth, { proposalId, revisionId }),
      PROPOSAL_MESSAGES.stale,
    )
    const { collabId } = await acceptProposal(testDb.db, builder.auth, {
      proposalId,
      revisionId: countered.revisionId,
    })

    expect(await proposalRow(proposalId)).toMatchObject({ status: "accepted", closedAt: later })
    const [collab] = await testDb.db.select().from(collabs).where(eq(collabs.id, collabId))
    expect(collab).toMatchObject({ proposalId, ideaId: idea.id, stage: "agreement" })
    const members = await testDb.db
      .select({
        userId: collabMembers.userId,
        role: collabMembers.role,
        split: collabMembers.splitPct,
      })
      .from(collabMembers)
      .where(eq(collabMembers.collabId, collabId))
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: creator.user.id, role: "creator", split: 70 },
        { userId: builder.user.id, role: "builder", split: 30 },
      ]),
    )
    const [ideaAfter] = await testDb.db.select().from(ideas).where(eq(ideas.id, idea.id))
    expect(ideaAfter?.status).toBe("in_collab")

    const [accepted] = await eventsOf(testDb.db, proposalId, "proposal.accepted")
    expect(accepted).toMatchObject({ actorUserId: builder.user.id })
    expect(accepted?.properties).toEqual({
      revision_number: 2,
      creator_split_pct: 70,
      builder_split_pct: 30,
      timeline_weeks: 8,
      collab_id: collabId,
    })
    expect(await eventsOf(testDb.db, collabId, "collab.created")).toHaveLength(1)
    const [notice] = await notificationsOf(testDb.db, creator.user.id, "proposal.accepted")
    expect(notice?.payload).toMatchObject({ proposal_id: proposalId, collab_id: collabId })
    expect((await emailsTo(creator)).map((email) => email.subject)).toContain(
      `${builder.profile.displayName} accepted your proposal`,
    )

    // A second answer finds it closed.
    await rejectsWith(
      declineProposal(testDb.db, builder.auth, { proposalId }),
      PROPOSAL_MESSAGES.closed.accepted,
    )
  })

  it("lets only one of two racing answers through", async () => {
    const { creator, builder, proposalId, revisionId } = await pitch()
    const results = await Promise.allSettled([
      acceptProposal(testDb.db, creator.auth, { proposalId, revisionId }),
      withdrawProposal(testDb.db, builder.auth, { proposalId }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const row = await proposalRow(proposalId)
    expect(["accepted", "withdrawn"]).toContain(row.status)
    const collabRows = await testDb.db
      .select()
      .from(collabs)
      .where(eq(collabs.proposalId, proposalId))
    expect(collabRows).toHaveLength(row.status === "accepted" ? 1 : 0)
  })

  it("rolls everything back when the idea is no longer open", async () => {
    const { creator, idea, proposalId, revisionId } = await pitch()
    await testDb.db
      .update(ideas)
      .set({ status: "archived", archivedAt: NOW })
      .where(eq(ideas.id, idea.id))
    await rejectsWith(
      acceptProposal(testDb.db, creator.auth, { proposalId, revisionId }),
      "This idea is no longer open",
    )
    expect((await proposalRow(proposalId)).status).toBe("pending")
    expect(await eventsOf(testDb.db, proposalId, "proposal.accepted")).toHaveLength(0)
    expect(
      await testDb.db.select().from(collabs).where(eq(collabs.proposalId, proposalId)),
    ).toEqual([])
  })
})

describe("declineProposal and withdrawProposal", () => {
  it("declines: closed, event, the sender notified", async () => {
    const { creator, builder, proposalId, revisionId } = await pitch()
    await declineProposal(testDb.db, creator.auth, { proposalId, revisionId })
    expect(await proposalRow(proposalId)).toMatchObject({
      status: "declined",
      closedAt: NOW,
      respondedAt: NOW,
    })
    const [event] = await eventsOf(testDb.db, proposalId, "proposal.declined")
    expect(event?.properties).toEqual({ revision_number: 1 })
    expect(await notificationsOf(testDb.db, builder.user.id, "proposal.declined")).toHaveLength(1)
    // The sender cannot decline their own offer, and nobody can withdraw a closed one.
    await rejectsWith(
      withdrawProposal(testDb.db, builder.auth, { proposalId }),
      PROPOSAL_MESSAGES.closed.declined,
    )
  })

  it("withdraws: only the current offer's author, the other party notified", async () => {
    const { creator, builder, proposalId } = await pitch()
    await rejectsWith(
      withdrawProposal(testDb.db, creator.auth, { proposalId }),
      PROPOSAL_MESSAGES.notYourOffer,
    )
    await rejectsWith(
      declineProposal(testDb.db, builder.auth, { proposalId }),
      PROPOSAL_MESSAGES.ownOffer,
    )
    await withdrawProposal(testDb.db, builder.auth, { proposalId })
    expect(await proposalRow(proposalId)).toMatchObject({
      status: "withdrawn",
      closedAt: NOW,
      respondedAt: null,
    })
    expect(await eventsOf(testDb.db, proposalId, "proposal.withdrawn")).toHaveLength(1)
    const [notice] = await notificationsOf(testDb.db, creator.user.id, "proposal.withdrawn")
    expect(notice?.payload).toMatchObject({ counterpart_name: builder.profile.displayName })
  })
})

describe("proposals/expire", () => {
  // Earlier tests left open proposals in this file's database: expire them all first, so each
  // test counts only its own.
  beforeEach(async () => {
    await expireDueProposals(testDb.db, { at: new Date(NOW.getTime() + 1000 * DAY) })
  })

  it("expires open proposals past expires_at, once, and notifies both parties", async () => {
    const due = await pitch()
    const answered = await pitch()
    await declineProposal(testDb.db, answered.creator.auth, { proposalId: answered.proposalId })
    setClockForTests(new Date(NOW.getTime() + 2 * DAY))
    const fresh = await pitch()

    const at = new Date(NOW.getTime() + 14 * DAY + 60_000)
    setClockForTests(at)
    expect(await expireDueProposals(testDb.db)).toEqual({ expired: 1, checked: 1, failed: 0 })

    expect(await proposalRow(due.proposalId)).toMatchObject({ status: "expired", closedAt: at })
    expect((await proposalRow(answered.proposalId)).status).toBe("declined")
    expect((await proposalRow(fresh.proposalId)).status).toBe("pending")
    const [event] = await eventsOf(testDb.db, due.proposalId, "proposal.expired")
    expect(event).toMatchObject({ actorUserId: null })
    expect(event?.properties).toEqual({ revision_number: 1 })
    const toCreator = await notificationsOf(testDb.db, due.creator.user.id, "proposal.expired")
    const toBuilder = await notificationsOf(testDb.db, due.builder.user.id, "proposal.expired")
    expect(toCreator[0]?.payload).toMatchObject({
      counterpart_name: due.builder.profile.displayName,
    })
    expect(toBuilder[0]?.payload).toMatchObject({
      counterpart_name: due.creator.profile.displayName,
    })

    // The hourly job (inline) finds nothing more to do.
    const job = findJob("proposals-expire")
    expect(await job?.runInline({})).toEqual({ expired: 0, checked: 0, failed: 0 })
    expect(await eventsOf(testDb.db, due.proposalId, "proposal.expired")).toHaveLength(1)
    expect(await notificationsOf(testDb.db, due.creator.user.id, "proposal.expired")).toHaveLength(
      1,
    )
  })

  it("refuses answers once the proposal is past due, before the job sweeps it", async () => {
    const { creator, builder, proposalId, revisionId } = await pitch()
    setClockForTests(new Date(NOW.getTime() + 14 * DAY + 1000))
    await rejectsWith(
      acceptProposal(testDb.db, creator.auth, { proposalId, revisionId }),
      PROPOSAL_MESSAGES.closed.expired,
    )
    await rejectsWith(
      withdrawProposal(testDb.db, builder.auth, { proposalId }),
      PROPOSAL_MESSAGES.closed.expired,
    )
    expect((await proposalRow(proposalId)).status).toBe("pending")
  })

  it("lets a counter push the expiry back, and walks large backlogs in batches", async () => {
    const { creator, proposalId, revisionId } = await pitch()
    const backlog = [await pitch(), await pitch(), await pitch()]
    setClockForTests(new Date(NOW.getTime() + 10 * DAY))
    await counterProposal(testDb.db, creator.auth, { proposalId, revisionId, terms: terms() })

    setClockForTests(new Date(NOW.getTime() + 15 * DAY))
    expect(await expireDueProposals(testDb.db, { batchSize: 2 })).toEqual({
      expired: 3,
      checked: 3,
      failed: 0,
    })
    expect((await proposalRow(proposalId)).status).toBe("countered")
    for (const item of backlog) expect((await proposalRow(item.proposalId)).status).toBe("expired")
  })
})

describe("proposal lists", () => {
  it("splits proposals into received, sent and closed, and knows whose turn it is", async () => {
    const { creator, builder, proposalId, revisionId } = await pitch()
    const other = await pitch()
    await declineProposal(testDb.db, other.creator.auth, { proposalId: other.proposalId })

    expect(
      (await listProposals(testDb.db, creator.user.id, "received")).items.map((p) => p.id),
    ).toEqual([proposalId])
    expect(await listProposals(testDb.db, creator.user.id, "sent")).toEqual({
      items: [],
      hasMore: false,
    })
    const [sent] = (await listProposals(testDb.db, builder.user.id, "sent")).items
    expect(sent).toMatchObject({
      id: proposalId,
      sentByUser: true,
      yourTurn: false,
      counterpart: { userId: creator.user.id, role: "creator", name: creator.profile.displayName },
      target: { kind: "idea", title: "Budget tracker for students" },
    })
    expect(await listProposalsAwaitingUser(testDb.db, builder.user.id)).toEqual([])
    expect((await listProposalsAwaitingUser(testDb.db, creator.user.id)).map((p) => p.id)).toEqual([
      proposalId,
    ])

    await counterProposal(testDb.db, creator.auth, { proposalId, revisionId, terms: terms() })
    expect((await listProposalsAwaitingUser(testDb.db, builder.user.id)).map((p) => p.id)).toEqual([
      proposalId,
    ])
    expect(await countProposalTabs(testDb.db, builder.user.id)).toEqual({
      received: 0,
      sent: 1,
      closed: 0,
      yourTurn: 1,
    })
    expect(
      (await listProposals(testDb.db, other.builder.user.id, "closed")).items[0],
    ).toMatchObject({
      id: other.proposalId,
      status: "declined",
    })
  })

  it("pages through a tab with a cursor, so no proposal is out of reach", async () => {
    const builder = await onboardedBuilder(testDb.db)
    const sentIds: string[] = []
    for (let index = 0; index < 5; index += 1) {
      setClockForTests(new Date(NOW.getTime() + index * 60_000))
      const creator = await onboardedCreator(testDb.db)
      const idea = await openIdea(testDb.db, creator)
      const { proposalId } = await sendProposal(testDb.db, builder.auth, {
        recipientId: creator.user.id,
        target: { kind: "idea", id: idea.id },
        matchId: null,
        terms: terms(),
      })
      sentIds.push(proposalId)
    }
    const seen: string[] = []
    let page = await listProposals(testDb.db, builder.user.id, "sent", { limit: 2 })
    seen.push(...page.items.map((item) => item.id))
    while (page.hasMore) {
      const last = page.items.at(-1)
      if (!last) break
      page = await listProposals(testDb.db, builder.user.id, "sent", {
        limit: 2,
        before: proposalCursorAfter(last, "sent"),
      })
      seen.push(...page.items.map((item) => item.id))
    }
    // Newest first, every proposal exactly once.
    expect(seen).toEqual([...sentIds].reverse())
  })
})

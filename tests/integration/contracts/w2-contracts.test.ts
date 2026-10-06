import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { jobsFor } from "@/inngest/functions"
import { ActionError } from "@/lib/actions/errors"
import { setClockForTests } from "@/lib/clock"
import { touchCollabActivity } from "@/lib/collabs/activity"
import { createCollabFromProposal } from "@/lib/collabs/create"
import {
  canChangeCollabStage,
  changeCollabStage,
  CollabStageConflictError,
} from "@/lib/collabs/stage"
import {
  collabMembers,
  collabs,
  events,
  ideas,
  products,
  proposals,
  threadReads,
  threads,
} from "@/lib/db/schema"
import { requestEmbeddingRefresh } from "@/lib/embeddings/request"
import { requestMatchingRecompute, requestTargetRescore } from "@/lib/matching/request"
import { createThread } from "@/lib/threads/create"

import { setupTestDatabase } from "../../helpers/db"
import {
  insertBuilder,
  insertCollab,
  insertCreator,
  insertIdea,
  insertProduct,
  insertProposal,
} from "../../helpers/db-fixtures"
import { stubServiceEnv } from "../../helpers/service-env"

/** The cross-area functions the W2 prep wrote ahead of the Phase 2–3 builders (CLAUDE.md §19.24). */

// Accepting generates the agreement, which emails both members: keep that out of the repo's .data/.
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  const os = await import("node:os")
  const root = nodePath.join(os.tmpdir(), `w2-contracts-${process.pid}`)
  return { dataDir: (...segments: string[]) => nodePath.join(root, ...segments) }
})

const testDb = setupTestDatabase()

beforeEach(() => stubServiceEnv())
afterEach(() => setClockForTests(null))

async function acceptedProposal(target: "idea" | "product", options: { exclusive?: boolean } = {}) {
  const creator = await insertCreator(testDb.db)
  const builder = await insertBuilder(testDb.db)
  const idea = await insertIdea(testDb.db, creator.profile.id, { status: "open" })
  const product = await insertProduct(testDb.db, builder.profile.id, {
    status: "seeking",
    exclusivity: options.exclusive ?? false,
  })
  // A creator offering their own idea to a builder, or pitching on a builder's product: the
  // sender is the creator either way, so the roles come from the target, not the direction.
  const { proposal } = await insertProposal(testDb.db, {
    fromUserId: creator.user.id,
    toUserId: builder.user.id,
    ...(target === "idea" ? { ideaId: idea.id } : { productId: product.id }),
    creatorSplitPct: 70,
  })
  await testDb.db
    .update(proposals)
    .set({ status: "accepted", closedAt: new Date(), respondedAt: new Date() })
    .where(eq(proposals.id, proposal.id))
  return { creator, builder, idea, product, proposal }
}

describe("createCollabFromProposal", () => {
  it("creates the collab, both members with the revision's splits, the thread and collab.created", async () => {
    const at = new Date("2026-05-01T10:00:00.000Z")
    setClockForTests(at)
    const { creator, builder, idea, proposal } = await acceptedProposal("idea")

    const result = await testDb.db.transaction((tx) =>
      createCollabFromProposal(proposal.id, tx, { actorUserId: builder.user.id }),
    )
    expect(result.created).toBe(true)
    expect(result.agreementId).toEqual(expect.any(String))

    const [collab] = await testDb.db.select().from(collabs).where(eq(collabs.id, result.collabId))
    expect(collab).toMatchObject({
      proposalId: proposal.id,
      ideaId: idea.id,
      productId: null,
      stage: "agreement",
      stageChangedAt: at,
      lastActivityAt: at,
    })
    const members = await testDb.db
      .select({
        userId: collabMembers.userId,
        role: collabMembers.role,
        split: collabMembers.splitPct,
      })
      .from(collabMembers)
      .where(eq(collabMembers.collabId, result.collabId))
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: creator.user.id, role: "creator", split: 70 },
        { userId: builder.user.id, role: "builder", split: 30 },
      ]),
    )
    const reads = await testDb.db
      .select({ userId: threadReads.userId, lastReadAt: threadReads.lastReadAt })
      .from(threadReads)
      .where(eq(threadReads.threadId, result.threadId))
    expect(reads.map((read) => read.userId).sort()).toEqual(
      [creator.user.id, builder.user.id].sort(),
    )
    expect(reads.every((read) => read.lastReadAt === null)).toBe(true)

    const [ideaAfter] = await testDb.db.select().from(ideas).where(eq(ideas.id, idea.id))
    expect(ideaAfter?.status).toBe("in_collab")
    const created = await testDb.db
      .select()
      .from(events)
      .where(and(eq(events.type, "collab.created"), eq(events.subjectId, result.collabId)))
    expect(created).toHaveLength(1)
    expect(created[0]?.actorUserId).toBe(builder.user.id)
    expect(created[0]?.properties).toEqual({
      proposal_id: proposal.id,
      idea_id: idea.id,
      product_id: null,
    })
  })

  it("is idempotent: a second call returns the same collab", async () => {
    const { builder, proposal } = await acceptedProposal("idea")
    const first = await testDb.db.transaction((tx) =>
      createCollabFromProposal(proposal.id, tx, { actorUserId: builder.user.id }),
    )
    const second = await testDb.db.transaction((tx) =>
      createCollabFromProposal(proposal.id, tx, { actorUserId: builder.user.id }),
    )
    // Only the first call has notices to send (after its commit).
    expect(first.readyNotices).toHaveLength(2)
    expect(second).toEqual({ ...first, created: false, readyNotices: [] })
  })

  it("creates one collab when two calls race (the check runs under the proposal's lock)", async () => {
    const { builder, proposal } = await acceptedProposal("product")
    const results = await Promise.all(
      [0, 1].map(() =>
        testDb.db.transaction((tx) =>
          createCollabFromProposal(proposal.id, tx, { actorUserId: builder.user.id }),
        ),
      ),
    )
    expect(results.map((result) => result.created).sort()).toEqual([false, true])
    expect(results[0]?.collabId).toBe(results[1]?.collabId)
    expect(
      await testDb.db.select().from(collabs).where(eq(collabs.proposalId, proposal.id)),
    ).toHaveLength(1)
  })

  it("keeps a non-exclusive product seeking and moves an exclusive one to in_collab", async () => {
    const open = await acceptedProposal("product")
    const shared = await testDb.db.transaction((tx) =>
      createCollabFromProposal(open.proposal.id, tx, { actorUserId: open.builder.user.id }),
    )
    const [stillSeeking] = await testDb.db
      .select()
      .from(products)
      .where(eq(products.id, open.product.id))
    expect(stillSeeking?.status).toBe("seeking")
    const [members] = await testDb.db
      .select({ role: collabMembers.role })
      .from(collabMembers)
      .where(
        and(
          eq(collabMembers.collabId, shared.collabId),
          eq(collabMembers.userId, open.builder.user.id),
        ),
      )
    expect(members?.role).toBe("builder")

    const exclusive = await acceptedProposal("product", { exclusive: true })
    await testDb.db.transaction((tx) =>
      createCollabFromProposal(exclusive.proposal.id, tx, {
        actorUserId: exclusive.builder.user.id,
      }),
    )
    const [taken] = await testDb.db
      .select()
      .from(products)
      .where(eq(products.id, exclusive.product.id))
    expect(taken?.status).toBe("in_collab")
  })

  it("refuses, with a plain message and nothing written, when the idea is no longer open", async () => {
    const { builder, idea, proposal } = await acceptedProposal("idea")
    await testDb.db
      .update(ideas)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(ideas.id, idea.id))
    const attempt = testDb.db.transaction((tx) =>
      createCollabFromProposal(proposal.id, tx, { actorUserId: builder.user.id }),
    )
    await expect(attempt).rejects.toBeInstanceOf(ActionError)
    await expect(attempt).rejects.toThrow("This idea is no longer open for a collaboration.")
    expect(
      await testDb.db.select().from(collabs).where(eq(collabs.proposalId, proposal.id)),
    ).toEqual([])
  })

  it("refuses a proposal that was not accepted first", async () => {
    const creator = await insertCreator(testDb.db)
    const builder = await insertBuilder(testDb.db)
    const idea = await insertIdea(testDb.db, creator.profile.id, { status: "open" })
    const { proposal } = await insertProposal(testDb.db, {
      fromUserId: builder.user.id,
      toUserId: creator.user.id,
      ideaId: idea.id,
    })
    await expect(
      testDb.db.transaction((tx) =>
        createCollabFromProposal(proposal.id, tx, { actorUserId: creator.user.id }),
      ),
    ).rejects.toThrow("is pending")
  })
})

describe("createThread", () => {
  it("creates a proposal thread once, with a read row per participant", async () => {
    const creator = await insertCreator(testDb.db)
    const builder = await insertBuilder(testDb.db)
    const idea = await insertIdea(testDb.db, creator.profile.id, { status: "open" })
    const { proposal } = await insertProposal(testDb.db, {
      fromUserId: builder.user.id,
      toUserId: creator.user.id,
      ideaId: idea.id,
    })
    const participants = [builder.user.id, creator.user.id]
    const first = await testDb.db.transaction((tx) =>
      createThread(tx, {
        kind: "proposal",
        proposalId: proposal.id,
        participantUserIds: participants,
      }),
    )
    const again = await testDb.db.transaction((tx) =>
      createThread(tx, {
        kind: "proposal",
        proposalId: proposal.id,
        participantUserIds: participants,
      }),
    )
    expect(again).toEqual(first)
    expect(
      await testDb.db.select().from(threads).where(eq(threads.proposalId, proposal.id)),
    ).toHaveLength(1)
    const reads = await testDb.db
      .select()
      .from(threadReads)
      .where(eq(threadReads.threadId, first.threadId))
    expect(reads).toHaveLength(2)
  })
})

describe("collab activity and stages", () => {
  it("moves last_activity_at forward only", async () => {
    setClockForTests(new Date("2026-05-10T00:00:00.000Z"))
    const { collab } = await insertCollab(testDb.db, { stage: "building" })
    await touchCollabActivity(testDb.db, collab.id, new Date("2026-05-12T00:00:00.000Z"))
    await touchCollabActivity(testDb.db, collab.id, new Date("2026-05-11T00:00:00.000Z"))
    const [after] = await testDb.db.select().from(collabs).where(eq(collabs.id, collab.id))
    expect(after?.lastActivityAt).toEqual(new Date("2026-05-12T00:00:00.000Z"))
  })

  it("changes the stage conditionally, with its timestamps and events", async () => {
    const at = new Date("2026-05-20T08:00:00.000Z")
    const { collab, creator } = await insertCollab(testDb.db, { stage: "agreement" })
    setClockForTests(at)
    await testDb.db.transaction((tx) =>
      changeCollabStage(tx, {
        collabId: collab.id,
        from: "agreement",
        to: "building",
        actorUserId: null,
      }),
    )
    const [building] = await testDb.db.select().from(collabs).where(eq(collabs.id, collab.id))
    expect(building).toMatchObject({ stage: "building", stageChangedAt: at, lastActivityAt: at })

    // A racing second change from the old stage fails and rolls back.
    await expect(
      testDb.db.transaction((tx) =>
        changeCollabStage(tx, {
          collabId: collab.id,
          from: "agreement",
          to: "building",
          actorUserId: null,
        }),
      ),
    ).rejects.toBeInstanceOf(CollabStageConflictError)

    await testDb.db.transaction((tx) =>
      changeCollabStage(tx, {
        collabId: collab.id,
        from: "building",
        to: "ended",
        actorUserId: creator.user.id,
        endedReason: "cancelled",
      }),
    )
    const [ended] = await testDb.db.select().from(collabs).where(eq(collabs.id, collab.id))
    expect(ended).toMatchObject({ stage: "ended", endedReason: "cancelled", endedAt: at })
    const rows = await testDb.db.select().from(events).where(eq(events.subjectId, collab.id))
    expect(rows.map((row) => [row.type, row.properties])).toEqual(
      expect.arrayContaining([
        ["collab.stage_changed", { from: "agreement", to: "building" }],
        ["collab.stage_changed", { from: "building", to: "ended" }],
        ["collab.ended", { from_stage: "building", reason: "cancelled" }],
      ]),
    )
    expect(canChangeCollabStage("ended", "building")).toBe(false)
    expect(canChangeCollabStage("agreement", "live")).toBe(false)
  })
})

describe("job requests", () => {
  it("enqueue the declared jobs, whose handlers are no-ops until their owners fill them in", async () => {
    const id = "0190a000-0000-7000-8000-000000000001"
    const spies = [
      vi.spyOn(jobsFor("embeddings/refresh.requested")[0]!, "runInline"),
      vi.spyOn(jobsFor("matching/recompute.requested")[0]!, "runInline"),
      vi.spyOn(jobsFor("matching/target-changed.requested")[0]!, "runInline"),
    ]
    await requestEmbeddingRefresh({ type: "idea", id })
    await requestMatchingRecompute({ userId: id, reason: "idea_changed" })
    await requestTargetRescore({ targetType: "idea", targetId: id })
    expect(spies[0]).toHaveBeenCalledWith({ subjectType: "idea", subjectId: id })
    expect(spies[1]).toHaveBeenCalledWith({ userId: id, reason: "idea_changed" })
    expect(spies[2]).toHaveBeenCalledWith({ targetType: "idea", targetId: id })
  })
})

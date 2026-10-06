import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthUser } from "@/lib/auth/user"
import { setClockForTests } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { collabs, proposals, users } from "@/lib/db/schema"
import { PROPOSAL_MESSAGES } from "@/lib/proposals/service"
import { resetMemoryRateLimits } from "@/lib/ratelimit"

import { setupTestDatabase } from "../../helpers/db"
import { stubServiceEnv } from "../../helpers/service-env"
import {
  makeTempDataDir,
  onboardedBuilder,
  onboardedCreator,
  openIdea,
  removeTempDataDir,
} from "./helpers"

/**
 * The proposal server actions with a mocked session (§4: Zod input, requireUser, authorize, then
 * the transition): form field errors, plain-language refusals from `authorize`, the redirect after
 * sending, and a whole negotiation (send → counter → accept) through the actions.
 */

const mocks = vi.hoisted(() => ({ dir: "", db: null as unknown, user: null as AuthUser | null }))
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const {
  acceptProposalAction,
  counterProposalAction,
  declineProposalAction,
  sendProposalAction,
  withdrawProposalAction,
} = await import("@/lib/proposals/actions")

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
  mocks.user = null
  stubServiceEnv()
  setClockForTests(NOW)
  resetMemoryRateLimits()
})
afterEach(async () => {
  setClockForTests(null)
  await closeDb()
})

function sendForm(fields: Record<string, string>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries({
    scope: "A recipe planner with a shopping list.",
    message: "Hi! I'd love to build this.",
    creatorSplitPct: "60",
    builderSplitPct: "40",
    timelineWeeks: "6",
    ...fields,
  })) {
    form.set(key, value)
  }
  return form
}

/** Next's redirect() throws an error whose digest carries the target. */
async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2] ?? ""
    }
    throw error
  }
  throw new Error("expected a redirect")
}

describe("proposal actions", () => {
  it("sends, counters and accepts through the actions", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const idea = await openIdea(testDb.db, creator)
    mocks.user = builder.auth

    // A split that does not add up comes back on the field; nothing is stored.
    expect(
      await sendProposalAction(
        sendForm({
          to: creator.user.id,
          targetKind: "idea",
          targetId: idea.id,
          builderSplitPct: "50",
        }),
      ),
    ).toEqual({
      ok: false,
      error: expect.any(String),
      fieldErrors: { creatorSplitPct: ["The creator's and builder's shares must add up to 100%."] },
    })

    const target = await redirectTarget(
      sendProposalAction(sendForm({ to: creator.user.id, targetKind: "idea", targetId: idea.id })),
    )
    expect(target).toMatch(/^\/app\/proposals\/[0-9a-f-]{36}\?sent=1$/)
    const proposalId = target.slice("/app/proposals/".length, target.indexOf("?"))
    const [sent] = await testDb.db.select().from(proposals).where(eq(proposals.id, proposalId))
    if (!sent?.currentRevisionId) throw new Error("no revision")

    // The sender cannot answer their own offer; the recipient counters.
    expect(await acceptProposalAction({ proposalId, revisionId: sent.currentRevisionId })).toEqual({
      ok: false,
      error: PROPOSAL_MESSAGES.ownOffer,
    })
    mocks.user = creator.auth
    const countered = await counterProposalAction({
      proposalId,
      revisionId: sent.currentRevisionId,
      scope: "Recipe planner, shopping list and pantry.",
      message: "",
      creatorSplitPct: "70",
      builderSplitPct: "30",
      timelineWeeks: "8",
    })
    expect(countered).toMatchObject({ ok: true, data: { revisionNumber: 2 } })
    if (!countered.ok) throw new Error(countered.error)
    expect(await withdrawProposalAction({ proposalId })).toEqual({
      ok: true,
      data: { withdrawn: true },
    })
    // Withdrawn: there is nothing left for the builder to accept.
    mocks.user = builder.auth
    expect(
      await acceptProposalAction({ proposalId, revisionId: countered.data.revisionId }),
    ).toEqual({ ok: false, error: PROPOSAL_MESSAGES.closed.withdrawn })

    // A fresh proposal, countered, then accepted by the builder.
    mocks.user = builder.auth
    const second = await redirectTarget(
      sendProposalAction(sendForm({ to: creator.user.id, targetKind: "idea", targetId: idea.id })),
    )
    const secondId = second.slice("/app/proposals/".length, second.indexOf("?"))
    const [row] = await testDb.db.select().from(proposals).where(eq(proposals.id, secondId))
    mocks.user = creator.auth
    const counter = await counterProposalAction({
      proposalId: secondId,
      revisionId: row?.currentRevisionId ?? "",
      message: undefined,
      scope: "Same, plus a pantry.",
      creatorSplitPct: "65",
      builderSplitPct: "35",
      timelineWeeks: "7",
    })
    if (!counter.ok) throw new Error(counter.error)
    mocks.user = builder.auth
    const accepted = await acceptProposalAction({
      proposalId: secondId,
      revisionId: counter.data.revisionId,
    })
    expect(accepted).toMatchObject({ ok: true, data: { collabId: expect.any(String) } })
    if (!accepted.ok) throw new Error(accepted.error)
    const [collab] = await testDb.db
      .select()
      .from(collabs)
      .where(eq(collabs.id, accepted.data.collabId))
    expect(collab).toMatchObject({ proposalId: secondId, stage: "agreement" })
    expect(
      await declineProposalAction({ proposalId: secondId, revisionId: counter.data.revisionId }),
    ).toEqual({ ok: false, error: PROPOSAL_MESSAGES.closed.accepted })
  })

  it("explains refusals before anything is written", async () => {
    const creator = await onboardedCreator(testDb.db)
    const builder = await onboardedBuilder(testDb.db)
    const idea = await openIdea(testDb.db, creator)

    // Not onboarded (the session says so): blocked with the reason.
    mocks.user = { ...builder.auth, onboardingCompletedAt: null }
    expect(
      await sendProposalAction(
        sendForm({ to: creator.user.id, targetKind: "idea", targetId: idea.id }),
      ),
    ).toEqual({ ok: false, error: "Finish setting up your account before you send a proposal." })

    // A recipient who was suspended meanwhile.
    mocks.user = builder.auth
    await testDb.db.update(users).set({ status: "suspended" }).where(eq(users.id, creator.user.id))
    expect(
      await sendProposalAction(
        sendForm({ to: creator.user.id, targetKind: "idea", targetId: idea.id }),
      ),
    ).toEqual({ ok: false, error: "This person isn't taking proposals right now." })

    // Bad ids never reach the database.
    expect(
      await sendProposalAction(sendForm({ to: "nope", targetKind: "idea", targetId: idea.id })),
    ).toMatchObject({ ok: false, fieldErrors: { to: ["That person link is not valid."] } })
    // A stranger answering someone else's proposal is told it does not exist.
    expect(
      await acceptProposalAction({
        proposalId: "0190a000-0000-7000-8000-00000000abcd",
        revisionId: "0190a000-0000-7000-8000-00000000abce",
      }),
    ).toEqual({ ok: false, error: PROPOSAL_MESSAGES.notFound })
  })
})

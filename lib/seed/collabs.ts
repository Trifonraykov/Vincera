import "server-only"

import { and, asc, eq, inArray } from "drizzle-orm"

import { loadActiveAgreement } from "@/lib/agreements/queries"
import { signAgreement } from "@/lib/agreements/sign"
import type { AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { changeCollabStage } from "@/lib/collabs/stage"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { agreements, collabMembers, creatorProfiles, ideas, threads, users } from "@/lib/db/schema"
import { postMessage } from "@/lib/messages/post"
import { acceptProposal, sendProposal } from "@/lib/proposals/service"
import { createTask, setTaskDone } from "@/lib/tasks/service"

import type { SeedStep } from "./types"

/**
 * Seed step "collabs" (owner: collab; CLAUDE.md §19.24 "Seed", §19.28): three collabs between
 * seeded people, each made through the app's own flow (a builder's proposal on a creator's open
 * idea, accepted by the creator, so the collab, its thread and its agreement are generated as in
 * the app), then taken to a different point:
 *
 *   1. creator 01 × builder 01: stage `agreement`, signed by the creator, waiting for the builder;
 *   2. creator 02 × builder 02: stage `ended` (reason `cancelled`): the creator called it off
 *      before anyone signed, so its agreement is `terminated`;
 *   3. creator 03 × builder 03: signed by both (PDF stored and emailed by the finalize job), in
 *      `building`, with tasks (one done) and a few messages. Phase 4's launch seed takes it on.
 *
 * Three different stages (§15); `launch_review` and `live` come with Phase 4's launches seed.
 *
 * Signing needs both members payouts-ready, which the people step sets up. Idempotent: a pair
 * that already shares a collab is skipped; so is a pair whose people or open idea are missing.
 */

type Plan = {
  pair: number
  signers: readonly ("creator" | "builder")[]
  /** End the collab (by the creator) after signing, with this reason. */
  end?: "cancelled"
  work: boolean
  scope: string
  creatorSplitPct: number
  timelineWeeks: number
}

const PLANS: readonly Plan[] = [
  {
    pair: 1,
    signers: ["creator"],
    work: false,
    scope:
      "A mobile-friendly web app with the recipes from the channel, a weekly plan and a shopping list.",
    creatorSplitPct: 55,
    timelineWeeks: 6,
  },
  {
    pair: 2,
    signers: [],
    end: "cancelled",
    work: false,
    scope: "A template pack with a guided setup page and three short walkthrough videos.",
    creatorSplitPct: 60,
    timelineWeeks: 4,
  },
  {
    pair: 3,
    signers: ["creator", "builder"],
    work: true,
    scope: "A small tool that turns the creator's checklists into a printable, shareable planner.",
    creatorSplitPct: 50,
    timelineWeeks: 8,
  },
]

const TASKS = [
  { title: "Agree on the first three features", done: true, owner: "creator" as const },
  { title: "Set up the repository and deploy a preview", done: false, owner: "builder" as const },
  { title: "Record a 30-second teaser for the launch", done: false, owner: "creator" as const },
]

const MESSAGES = [
  { from: "builder" as const, body: "Signed! I'll share a first preview link this week." },
  { from: "creator" as const, body: "Great, I'll **film the teaser** once the preview is up." },
]

const seedEmail = (role: "creator" | "builder", pair: number) =>
  `seed-${role}-${String(pair).padStart(2, "0")}@example.com`

async function loadSeedUser(
  database: DbOrTx,
  email: string,
): Promise<(AuthzUser & { name: string | null }) | null> {
  const [row] = await database
    .select({
      id: users.id,
      name: users.name,
      roles: users.roles,
      status: users.status,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.email, email))
  return row ?? null
}

async function shareACollab(database: DbOrTx, a: string, b: string): Promise<boolean> {
  const rows = await database
    .select({ collabId: collabMembers.collabId, userId: collabMembers.userId })
    .from(collabMembers)
    .where(inArray(collabMembers.userId, [a, b]))
  const byCollab = new Map<string, Set<string>>()
  for (const row of rows) {
    byCollab.set(row.collabId, (byCollab.get(row.collabId) ?? new Set()).add(row.userId))
  }
  return [...byCollab.values()].some((members) => members.size === 2)
}

async function firstOpenIdea(database: DbOrTx, creatorUserId: string): Promise<string | null> {
  const [row] = await database
    .select({ id: ideas.id })
    .from(ideas)
    .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .where(and(eq(creatorProfiles.userId, creatorUserId), eq(ideas.status, "open")))
    .orderBy(asc(ideas.createdAt), asc(ideas.id))
    .limit(1)
  return row?.id ?? null
}

export const seedCollabs: SeedStep = {
  name: "collabs",
  owner: "collab",
  run: async ({ db, log }) => {
    let created = 0
    const skipped: string[] = []
    for (const plan of PLANS) {
      const creator = await loadSeedUser(db, seedEmail("creator", plan.pair))
      const builder = await loadSeedUser(db, seedEmail("builder", plan.pair))
      if (!creator || !builder) {
        skipped.push(`pair ${plan.pair}: people missing`)
        continue
      }
      if (await shareACollab(db, creator.id, builder.id)) continue
      const ideaId = await firstOpenIdea(db, creator.id)
      if (!ideaId) {
        skipped.push(`pair ${plan.pair}: no open idea`)
        continue
      }

      const { proposalId, revisionId } = await sendProposal(db, builder, {
        recipientId: creator.id,
        target: { kind: "idea", id: ideaId },
        matchId: null,
        terms: {
          message: "Hi! I'd love to build this with you.",
          scope: plan.scope,
          creatorSplitPct: plan.creatorSplitPct,
          builderSplitPct: 100 - plan.creatorSplitPct,
          timelineWeeks: plan.timelineWeeks,
        },
      })
      const { collabId } = await acceptProposal(db, creator, { proposalId, revisionId })
      created += 1

      const agreement = await loadActiveAgreement(db, collabId)
      for (const role of plan.signers) {
        if (!agreement) break
        const person = role === "creator" ? creator : builder
        await signAgreement(db, person, {
          agreementId: agreement.id,
          typedName: person.name ?? (role === "creator" ? "Seed Creator" : "Seed Builder"),
          bodyHash: agreement.bodyHash,
          ip: null,
          userAgent: "seed",
        })
      }

      if (plan.end && agreement) {
        const endedReason = plan.end
        await withTransaction(async (tx) => {
          await changeCollabStage(tx, {
            collabId,
            from: "agreement",
            to: "ended",
            actorUserId: creator.id,
            endedReason,
          })
          // An ended collab's unsigned agreement can never be signed (Phase 6 builds the exit flow).
          await tx
            .update(agreements)
            .set({ status: "terminated", terminatedAt: now() })
            .where(
              and(eq(agreements.id, agreement.id), eq(agreements.status, "awaiting_signatures")),
            )
        }, db)
      }

      if (plan.work) {
        for (const task of TASKS) {
          const actor = task.owner === "creator" ? builder : creator
          const assignee = task.owner === "creator" ? creator : builder
          const { taskId } = await createTask(db, actor, {
            collabId,
            title: task.title,
            description: null,
            assigneeUserId: assignee.id,
            dueDate: null,
          })
          if (task.done) await setTaskDone(db, assignee, { taskId, done: true })
        }
        const [thread] = await db
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.collabId, collabId))
        for (const message of thread ? MESSAGES : []) {
          await postMessage(db, message.from === "creator" ? creator : builder, {
            threadId: thread?.id ?? "",
            body: message.body,
            attachments: [],
          })
        }
      }
    }
    if (skipped.length > 0) log(`  collabs: skipped ${skipped.join("; ")}`)
    return created > 0 || skipped.length === 0 ? { created } : { skipped: skipped.join("; ") }
  },
}

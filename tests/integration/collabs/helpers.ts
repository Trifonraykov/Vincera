import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, asc, eq } from "drizzle-orm"

import type { Db } from "@/lib/db/client"
import { agreements, events, notifications, users } from "@/lib/db/schema"
import { acceptProposal, sendProposal } from "@/lib/proposals/service"

import { insertStripeAccount } from "../../helpers/db-fixtures"
import {
  authUserOf,
  onboardedBuilder,
  onboardedCreator,
  openIdea,
  terms,
  type Person,
} from "../proposals/helpers"

/**
 * Shared setup for the collab integration tests (CLAUDE.md §19.28): a collab made through the real
 * proposal flow (send, then accept: `createCollabFromProposal` and the agreement generation run as
 * in the app), payouts-ready Stripe accounts, and readers.
 */

export { authUserOf, type Person }

export async function makeTempDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "collabs-test-"))
}

export async function removeTempDataDir(dir: string): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true })
}

/** A builder pitches on a creator's open idea (60/40, 6 weeks) and the creator accepts. */
export async function acceptedCollab(
  db: Db,
  options: { creatorSplitPct?: number; title?: string; scope?: string } = {},
) {
  const creator = await onboardedCreator(db)
  const builder = await onboardedBuilder(db)
  const idea = await openIdea(db, creator, options.title ?? "Budget tracker for students")
  const creatorSplitPct = options.creatorSplitPct ?? 60
  const { proposalId, revisionId } = await sendProposal(db, builder.auth, {
    recipientId: creator.user.id,
    target: { kind: "idea", id: idea.id },
    matchId: null,
    terms: terms({
      creatorSplitPct,
      builderSplitPct: 100 - creatorSplitPct,
      ...(options.scope ? { scope: options.scope } : {}),
    }),
  })
  const { collabId } = await acceptProposal(db, creator.auth, { proposalId, revisionId })
  const [agreement] = await db.select().from(agreements).where(eq(agreements.collabId, collabId))
  if (!agreement) throw new Error("acceptedCollab: no agreement")
  return { creator, builder, idea, proposalId, collabId, agreement }
}

/** A Stripe account that can receive transfers (§19.10 "payouts ready"). */
export async function makePayoutsReady(db: Db, userId: string) {
  return insertStripeAccount(db, userId, {
    payoutsEnabled: true,
    detailsSubmitted: true,
    transfersCapability: "active",
  })
}

export async function eventsOf(db: Db, subjectId: string, type?: string) {
  return db
    .select()
    .from(events)
    .where(
      type
        ? and(eq(events.subjectId, subjectId), eq(events.type, type))
        : eq(events.subjectId, subjectId),
    )
    .orderBy(asc(events.occurredAt), asc(events.id))
}

export async function notificationsOf(db: Db, userId: string, type?: string) {
  return db
    .select()
    .from(notifications)
    .where(
      type
        ? and(eq(notifications.userId, userId), eq(notifications.type, type))
        : eq(notifications.userId, userId),
    )
    .orderBy(asc(notifications.createdAt))
}

export async function setUserStatus(db: Db, userId: string, status: "active" | "suspended") {
  const [row] = await db.update(users).set({ status }).where(eq(users.id, userId)).returning()
  if (!row) throw new Error("setUserStatus: no user")
  return row
}

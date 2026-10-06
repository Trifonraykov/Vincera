import "server-only"

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm"

import type { CollabAccess } from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import {
  agreementSignatures,
  agreements,
  collabMembers,
  collabs,
  ideas,
  products,
  stripeAccounts,
  tasks,
  threads,
  type AgreementStatus,
  type CollabEndReason,
  type CollabRole,
  type CollabStage,
} from "@/lib/db/schema"
import { isPayoutsReady } from "@/lib/payouts/readiness"
import { loadPartyNames } from "@/lib/proposals/queries"

/**
 * Reads for the collab pages (§12 `/app/collabs/*`) and the collab services. Nothing here filters
 * by permission except the user-scoped list: callers authorize with `canViewCollab` /
 * `canWorkInCollab` (lib/auth/authz.ts) on what these return (CLAUDE.md §6: collab data only for
 * its members and admins).
 */

export type CollabMember = {
  userId: string
  role: CollabRole
  splitPct: number
  /** Display name of their profile for this role (never an email). */
  name: string
  handle: string | null
}

/** What every collab page needs: the collab, what it is about, and its members. */
export type CollabSummary = CollabAccess & {
  id: string
  proposalId: string
  stage: CollabStage
  stageChangedAt: Date
  lastActivityAt: Date
  endedAt: Date | null
  endedReason: CollabEndReason | null
  createdAt: Date
  target: { kind: "idea" | "product"; id: string; title: string }
  /** Creator first, then builder. */
  members: CollabMember[]
  threadId: string | null
}

const ROLE_ORDER: Record<CollabRole, number> = { creator: 0, builder: 1 }

/** The rows authorization needs (`CollabAccess` plus the stage), or null for an unknown collab. */
export async function loadCollabAccess(
  database: DbOrTx,
  collabId: string,
): Promise<(CollabAccess & { id: string; stage: CollabStage }) | null> {
  const [collab] = await database
    .select({ id: collabs.id, stage: collabs.stage })
    .from(collabs)
    .where(eq(collabs.id, collabId))
  if (!collab) return null
  const members = await database
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, collabId))
  return { ...collab, memberUserIds: members.map((member) => member.userId) }
}

/** The collab with its title (its idea's or product's), members and thread. */
export async function loadCollabSummary(
  database: DbOrTx,
  collabId: string,
): Promise<CollabSummary | null> {
  const [row] = await database
    .select({
      id: collabs.id,
      proposalId: collabs.proposalId,
      stage: collabs.stage,
      stageChangedAt: collabs.stageChangedAt,
      lastActivityAt: collabs.lastActivityAt,
      endedAt: collabs.endedAt,
      endedReason: collabs.endedReason,
      createdAt: collabs.createdAt,
      ideaId: collabs.ideaId,
      productId: collabs.productId,
      ideaTitle: ideas.title,
      productTitle: products.title,
      threadId: threads.id,
    })
    .from(collabs)
    .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
    .leftJoin(products, eq(products.id, collabs.productId))
    .leftJoin(threads, eq(threads.collabId, collabs.id))
    .where(eq(collabs.id, collabId))
  if (!row) return null
  const memberRows = await database
    .select({
      userId: collabMembers.userId,
      role: collabMembers.role,
      splitPct: collabMembers.splitPct,
    })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, collabId))
  const names = await loadPartyNames(database, memberRows)
  const members = memberRows
    .map((member) => ({
      ...member,
      name:
        names.get(member.userId)?.name ?? (member.role === "creator" ? "A creator" : "A builder"),
      handle: names.get(member.userId)?.handle ?? null,
    }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
  const target = row.ideaId
    ? { kind: "idea" as const, id: row.ideaId, title: row.ideaTitle ?? "Untitled idea" }
    : { kind: "product" as const, id: row.productId ?? "", title: row.productTitle ?? "Untitled" }
  return {
    id: row.id,
    proposalId: row.proposalId,
    stage: row.stage,
    stageChangedAt: row.stageChangedAt,
    lastActivityAt: row.lastActivityAt,
    endedAt: row.endedAt,
    endedReason: row.endedReason,
    createdAt: row.createdAt,
    target,
    members,
    memberUserIds: members.map((member) => member.userId),
    threadId: row.threadId,
  }
}

/** Payouts readiness per user (§12: both members must be payouts-ready to sign). */
export async function loadPayoutsReadiness(
  database: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>(userIds.map((id) => [id, false]))
  if (userIds.length === 0) return result
  const rows = await database
    .select({
      userId: stripeAccounts.userId,
      payoutsEnabled: stripeAccounts.payoutsEnabled,
      transfersCapability: stripeAccounts.transfersCapability,
    })
    .from(stripeAccounts)
    .where(inArray(stripeAccounts.userId, [...userIds]))
  for (const row of rows) result.set(row.userId, isPayoutsReady(row))
  return result
}

// --- Lists ---------------------------------------------------------------------------------------

export type CollabListItem = {
  id: string
  stage: CollabStage
  title: string
  targetKind: "idea" | "product"
  /** The viewer's role in it. */
  role: CollabRole
  splitPct: number
  /** The other member(s). */
  partners: { name: string; role: CollabRole }[]
  agreementStatus: AgreementStatus | null
  /** The viewer signed the agreement in force. */
  signedByViewer: boolean
  /** How many members signed it. */
  signatureCount: number
  openTasks: number
  lastActivityAt: Date
  stageChangedAt: Date
}

/** The user's collabs (as a member), most recent activity first. */
export async function listCollabsForUser(
  database: DbOrTx,
  userId: string,
  options: { limit?: number; activeOnly?: boolean } = {},
): Promise<CollabListItem[]> {
  const openTasks = sql<number>`(
    SELECT count(*)::int FROM ${tasks} t WHERE t.collab_id = ${collabs.id} AND t.done_at IS NULL
  )`
  const rows = await database
    .select({
      id: collabs.id,
      stage: collabs.stage,
      lastActivityAt: collabs.lastActivityAt,
      stageChangedAt: collabs.stageChangedAt,
      ideaId: collabs.ideaId,
      ideaTitle: ideas.title,
      productTitle: products.title,
      role: collabMembers.role,
      splitPct: collabMembers.splitPct,
      agreementId: agreements.id,
      agreementStatus: agreements.status,
      openTasks,
    })
    .from(collabMembers)
    .innerJoin(collabs, eq(collabs.id, collabMembers.collabId))
    .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
    .leftJoin(products, eq(products.id, collabs.productId))
    .leftJoin(
      agreements,
      and(eq(agreements.collabId, collabs.id), ne(agreements.status, "terminated")),
    )
    .where(
      and(
        eq(collabMembers.userId, userId),
        options.activeOnly ? ne(collabs.stage, "ended") : undefined,
      ),
    )
    .orderBy(desc(collabs.lastActivityAt), desc(collabs.id))
    .limit(options.limit ?? 200)
  if (rows.length === 0) return []

  const collabIds = rows.map((row) => row.id)
  const others = await database
    .select({
      collabId: collabMembers.collabId,
      userId: collabMembers.userId,
      role: collabMembers.role,
    })
    .from(collabMembers)
    .where(and(inArray(collabMembers.collabId, collabIds), ne(collabMembers.userId, userId)))
    .orderBy(asc(collabMembers.role))
  const names = await loadPartyNames(database, others)
  const agreementIds = rows.flatMap((row) => (row.agreementId ? [row.agreementId] : []))
  const signatures =
    agreementIds.length > 0
      ? await database
          .select({
            agreementId: agreementSignatures.agreementId,
            userId: agreementSignatures.userId,
          })
          .from(agreementSignatures)
          .where(inArray(agreementSignatures.agreementId, agreementIds))
      : []

  return rows.map((row) => {
    const signed = signatures.filter((signature) => signature.agreementId === row.agreementId)
    return {
      id: row.id,
      stage: row.stage,
      title: row.ideaTitle ?? row.productTitle ?? "Untitled",
      targetKind: row.ideaId ? "idea" : "product",
      role: row.role,
      splitPct: row.splitPct,
      partners: others
        .filter((other) => other.collabId === row.id)
        .map((other) => ({
          name: names.get(other.userId)?.name ?? "Your collaborator",
          role: other.role,
        })),
      agreementStatus: row.agreementStatus,
      signedByViewer: signed.some((signature) => signature.userId === userId),
      signatureCount: signed.length,
      openTasks: row.openTasks,
      lastActivityAt: row.lastActivityAt,
      stageChangedAt: row.stageChangedAt,
    }
  })
}

/** The agreement in force for a collab (not terminated), or null. */
export async function findActiveAgreementId(
  database: DbOrTx,
  collabId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ id: agreements.id })
    .from(agreements)
    .where(and(eq(agreements.collabId, collabId), ne(agreements.status, "terminated")))
  return row?.id ?? null
}

/** Open tasks per collab member assignment, for the overview. */
export async function countOpenTasks(
  database: DbOrTx,
  collabId: string,
): Promise<{ open: number; done: number; assignedTo: Map<string, number> }> {
  const rows = await database
    .select({
      assignee: tasks.assigneeUserId,
      done: sql<boolean>`${tasks.doneAt} IS NOT NULL`,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(eq(tasks.collabId, collabId))
    .groupBy(tasks.assigneeUserId, sql`${tasks.doneAt} IS NOT NULL`)
  const assignedTo = new Map<string, number>()
  let open = 0
  let done = 0
  for (const row of rows) {
    if (row.done) {
      done += row.count
      continue
    }
    open += row.count
    if (row.assignee) assignedTo.set(row.assignee, (assignedTo.get(row.assignee) ?? 0) + row.count)
  }
  return { open, done, assignedTo }
}

/** The idea's or product's title, for notification payloads (≤ 200 characters there). */
export async function loadCollabTitle(database: DbOrTx, collabId: string): Promise<string> {
  const [row] = await database
    .select({ ideaTitle: ideas.title, productTitle: products.title })
    .from(collabs)
    .leftJoin(ideas, eq(ideas.id, collabs.ideaId))
    .leftJoin(products, eq(products.id, collabs.productId))
    .where(eq(collabs.id, collabId))
  return row?.ideaTitle ?? row?.productTitle ?? "Your collab"
}

/** Ids of the members of a collab who are not `userId` (for "notify the other member"). */
export async function otherMemberIds(
  database: DbOrTx,
  collabId: string,
  userId: string,
): Promise<string[]> {
  const rows = await database
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(and(eq(collabMembers.collabId, collabId), ne(collabMembers.userId, userId)))
  return rows.map((row) => row.userId)
}

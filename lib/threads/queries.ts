import "server-only"

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  ideas,
  messages,
  products,
  proposals,
  threadReads,
  threads,
  type CollabRole,
  type CollabStage,
  type MessageAttachment,
  type ProposalStatus,
  type ThreadKind,
} from "@/lib/db/schema"
import {
  loadPartyNames,
  loadProposalTarget,
  targetRefOf,
  type PartyInfo,
} from "@/lib/proposals/queries"
import { partyRole } from "@/lib/proposals/state"

import type { ThreadInfo } from "./access"

/**
 * Reads for threads: a thread's messages, the inbox (`/app/messages`) and the unread counts the
 * shell shows (CLAUDE.md §19.24 "Threads and messages"). A user's threads are their `thread_reads`
 * rows (one per participant from the thread's creation); unread = messages by others newer than
 * `coalesce(last_read_at, '-infinity')`.
 */

const NEVER = sql`'-infinity'::timestamptz`

// --- Messages -------------------------------------------------------------------------------------

export type ThreadMessage = {
  id: string
  authorUserId: string
  body: string
  attachments: MessageAttachment[]
  createdAt: Date
}

/** Messages shown per thread page: the newest ones, oldest first. */
export const THREAD_MESSAGE_LIMIT = 200

export async function listThreadMessages(
  database: DbOrTx,
  threadId: string,
  limit = THREAD_MESSAGE_LIMIT,
): Promise<{ messages: ThreadMessage[]; olderCount: number }> {
  const newest = await database
    .select({
      id: messages.id,
      authorUserId: messages.authorUserId,
      body: messages.body,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit)
  const [total] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.threadId, threadId))
  return {
    messages: newest.reverse(),
    olderCount: Math.max(0, (total?.count ?? 0) - newest.length),
  }
}

/** Names of a thread's participants, by user id (their role's profile name). */
export async function loadThreadParticipants(
  database: DbOrTx,
  thread: ThreadInfo,
): Promise<Map<string, PartyInfo>> {
  if (thread.kind === "collab" && thread.collabId) {
    const members = await database
      .select({ userId: collabMembers.userId, role: collabMembers.role })
      .from(collabMembers)
      .where(eq(collabMembers.collabId, thread.collabId))
    return loadPartyNames(database, members)
  }
  if (!thread.proposalId) return new Map()
  const [proposal] = await database
    .select({ ideaId: proposals.ideaId, productId: proposals.productId })
    .from(proposals)
    .where(eq(proposals.id, thread.proposalId))
  const target = proposal ? await loadProposalTarget(database, targetRefOf(proposal)) : null
  if (!target) return new Map()
  return loadPartyNames(
    database,
    thread.participantUserIds.map((userId) => ({ userId, role: partyRole(target, userId) })),
  )
}

// --- Reading --------------------------------------------------------------------------------------

/**
 * Opening a thread: the user's `last_read_at` moves to `upToMessageId`, the newest message the
 * page showed (never backwards), so a message that arrived after the page rendered stays unread
 * (CLAUDE.md §19.30). Without it, to the thread's newest message. A message id from another thread
 * changes nothing. Only participants have a row; for anyone else (an admin reading) nothing
 * changes.
 */
export async function markThreadRead(
  database: DbOrTx,
  userId: string,
  threadId: string,
  upToMessageId?: string,
): Promise<boolean> {
  const cutoff = upToMessageId
    ? sql`(
        SELECT ${messages.createdAt} FROM ${messages}
        WHERE ${messages.id} = ${upToMessageId} AND ${messages.threadId} = ${threadId}
      )`
    : sql`(SELECT max(${messages.createdAt}) FROM ${messages} WHERE ${messages.threadId} = ${threadId})`
  const updated = await database
    .update(threadReads)
    .set({ lastReadAt: sql`greatest(coalesce(${threadReads.lastReadAt}, ${NEVER}), ${cutoff})` })
    .where(
      and(
        eq(threadReads.threadId, threadId),
        eq(threadReads.userId, userId),
        sql`${cutoff} > coalesce(${threadReads.lastReadAt}, ${NEVER})`,
      ),
    )
    .returning({ id: threadReads.id })
  return updated.length > 0
}

/** Messages by others the user has not seen, across all their threads (the Inbox badge). */
export async function countUnreadMessages(database: DbOrTx, userId: string): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(threadReads)
    .innerJoin(messages, eq(messages.threadId, threadReads.threadId))
    .where(
      and(
        eq(threadReads.userId, userId),
        ne(messages.authorUserId, userId),
        sql`${messages.createdAt} > coalesce(${threadReads.lastReadAt}, ${NEVER})`,
      ),
    )
  return row?.count ?? 0
}

// --- Inbox ----------------------------------------------------------------------------------------

export type InboxThread = {
  id: string
  kind: ThreadKind
  /** The page the thread lives on. */
  href: string
  /** What the thread is about (the idea or product title). */
  title: string
  /** The other participants' names. */
  with: string[]
  parentStatus: ProposalStatus | CollabStage
  lastMessageAt: Date | null
  /** The newest message as plain text, shortened; null without messages. */
  preview: string | null
  previewByUser: boolean
  unread: number
}

export const INBOX_LIMIT = 100

/** Markdown punctuation out, whitespace collapsed: enough for a one-line preview. */
export function plainPreview(body: string, max = 140): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * The user's threads, newest activity first, with unread counts and the newest message. Proposal
 * threads open on `/app/proposals/<id>`, collab threads on `/app/collabs/<id>/messages` (§12).
 */
export async function listInbox(
  database: DbOrTx,
  userId: string,
  limit = INBOX_LIMIT,
): Promise<InboxThread[]> {
  const unread = sql<number>`(
    SELECT count(*)::int FROM ${messages} m
    WHERE m.thread_id = ${threads.id} AND m.author_user_id <> ${userId}
      AND m.created_at > coalesce(${threadReads.lastReadAt}, ${NEVER})
  )`
  const lastBody = sql<string | null>`(
    SELECT m.body FROM ${messages} m WHERE m.thread_id = ${threads.id}
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  )`
  const lastAuthor = sql<string | null>`(
    SELECT m.author_user_id FROM ${messages} m WHERE m.thread_id = ${threads.id}
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  )`
  const rows = await database
    .select({
      id: threads.id,
      kind: threads.kind,
      proposalId: threads.proposalId,
      collabId: threads.collabId,
      lastMessageAt: threads.lastMessageAt,
      createdAt: threads.createdAt,
      proposalStatus: proposals.status,
      fromUserId: proposals.fromUserId,
      toUserId: proposals.toUserId,
      collabStage: collabs.stage,
      ideaTitle: ideas.title,
      ideaOwnerUserId: creatorProfiles.userId,
      productTitle: products.title,
      productOwnerUserId: builderProfiles.userId,
      unread,
      lastBody,
      lastAuthor,
    })
    .from(threadReads)
    .innerJoin(threads, eq(threads.id, threadReads.threadId))
    .leftJoin(proposals, eq(proposals.id, threads.proposalId))
    .leftJoin(collabs, eq(collabs.id, threads.collabId))
    .leftJoin(ideas, sql`${ideas.id} = coalesce(${proposals.ideaId}, ${collabs.ideaId})`)
    .leftJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
    .leftJoin(
      products,
      sql`${products.id} = coalesce(${proposals.productId}, ${collabs.productId})`,
    )
    .leftJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
    .where(eq(threadReads.userId, userId))
    .orderBy(desc(sql`coalesce(${threads.lastMessageAt}, ${threads.createdAt})`), desc(threads.id))
    .limit(limit)

  // The other participants: the other party of a proposal, the other members of a collab.
  const collabIds = rows.flatMap((row) => (row.collabId ? [row.collabId] : []))
  const members =
    collabIds.length > 0
      ? await database
          .select({
            collabId: collabMembers.collabId,
            userId: collabMembers.userId,
            role: collabMembers.role,
          })
          .from(collabMembers)
          .where(and(inArray(collabMembers.collabId, collabIds), ne(collabMembers.userId, userId)))
          .orderBy(asc(collabMembers.role))
      : []
  const others = new Map<string, { userId: string; role: CollabRole }[]>()
  for (const row of rows) {
    if (row.kind !== "proposal" || !row.fromUserId || !row.toUserId) continue
    const other = row.fromUserId === userId ? row.toUserId : row.fromUserId
    const target = row.ideaOwnerUserId
      ? { kind: "idea" as const, ownerUserId: row.ideaOwnerUserId }
      : row.productOwnerUserId
        ? { kind: "product" as const, ownerUserId: row.productOwnerUserId }
        : null
    if (target) others.set(row.id, [{ userId: other, role: partyRole(target, other) }])
  }
  for (const member of members) {
    const thread = rows.find((row) => row.collabId === member.collabId)
    if (!thread) continue
    others.set(thread.id, [...(others.get(thread.id) ?? []), member])
  }
  const names = await loadPartyNames(database, [...others.values()].flat())

  return rows.flatMap((row) => {
    const parentStatus = row.kind === "proposal" ? row.proposalStatus : row.collabStage
    const parentId = row.kind === "proposal" ? row.proposalId : row.collabId
    if (!parentStatus || !parentId) return []
    return [
      {
        id: row.id,
        kind: row.kind,
        href:
          row.kind === "proposal"
            ? `/app/proposals/${parentId}#messages`
            : `/app/collabs/${parentId}/messages`,
        title: row.ideaTitle ?? row.productTitle ?? "Conversation",
        with: (others.get(row.id) ?? []).map((party) => names.get(party.userId)?.name ?? "Someone"),
        parentStatus,
        lastMessageAt: row.lastMessageAt,
        preview: row.lastBody ? plainPreview(row.lastBody) : null,
        previewByUser: row.lastAuthor === userId,
        unread: row.unread,
      },
    ]
  })
}

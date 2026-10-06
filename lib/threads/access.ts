import "server-only"

import { eq } from "drizzle-orm"

import type { ThreadAccess } from "@/lib/auth/authz"
import type { DbOrTx } from "@/lib/db/client"
import {
  collabMembers,
  collabs,
  proposals,
  threads,
  type CollabStage,
  type ProposalStatus,
  type ThreadKind,
} from "@/lib/db/schema"

/**
 * What the thread rules (`canViewThread`, `canPostMessage` in lib/auth/authz.ts) need about a
 * thread: its kind, its participants (the proposal's two parties, or the collab's members) and its
 * parent's status or stage. Authorization always comes from the parent, never from `thread_reads`.
 */

export type ThreadInfo = ThreadAccess & {
  id: string
  proposalId: string | null
  collabId: string | null
}

export async function loadThreadAccess(
  database: DbOrTx,
  threadId: string,
): Promise<ThreadInfo | null> {
  const [thread] = await database
    .select({
      id: threads.id,
      kind: threads.kind,
      proposalId: threads.proposalId,
      collabId: threads.collabId,
      proposalStatus: proposals.status,
      fromUserId: proposals.fromUserId,
      toUserId: proposals.toUserId,
      collabStage: collabs.stage,
    })
    .from(threads)
    .leftJoin(proposals, eq(proposals.id, threads.proposalId))
    .leftJoin(collabs, eq(collabs.id, threads.collabId))
    .where(eq(threads.id, threadId))
  if (!thread) return null
  return toThreadInfo(database, thread)
}

/** The thread of a proposal or collab, by its parent. */
export async function loadThreadAccessByParent(
  database: DbOrTx,
  parent: { kind: ThreadKind; id: string },
): Promise<ThreadInfo | null> {
  const [thread] = await database
    .select({ id: threads.id })
    .from(threads)
    .where(
      parent.kind === "proposal"
        ? eq(threads.proposalId, parent.id)
        : eq(threads.collabId, parent.id),
    )
  return thread ? loadThreadAccess(database, thread.id) : null
}

async function toThreadInfo(
  database: DbOrTx,
  thread: {
    id: string
    kind: ThreadKind
    proposalId: string | null
    collabId: string | null
    proposalStatus: ProposalStatus | null
    fromUserId: string | null
    toUserId: string | null
    collabStage: CollabStage | null
  },
): Promise<ThreadInfo | null> {
  if (thread.kind === "proposal") {
    if (!thread.proposalStatus || !thread.fromUserId || !thread.toUserId) return null
    return {
      id: thread.id,
      kind: "proposal",
      proposalId: thread.proposalId,
      collabId: null,
      participantUserIds: [thread.fromUserId, thread.toUserId],
      parentStatus: thread.proposalStatus,
    }
  }
  if (!thread.collabId || !thread.collabStage) return null
  const members = await database
    .select({ userId: collabMembers.userId })
    .from(collabMembers)
    .where(eq(collabMembers.collabId, thread.collabId))
  return {
    id: thread.id,
    kind: "collab",
    proposalId: null,
    collabId: thread.collabId,
    participantUserIds: members.map((member) => member.userId),
    parentStatus: thread.collabStage,
  }
}

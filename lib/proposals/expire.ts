import "server-only"

import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm"

import { OPEN_PROPOSAL_STATUSES } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { proposalRevisions, proposals } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { reportError } from "@/lib/observability"

import { notifyProposalClosed } from "./notifications"
import { loadPartyNames, loadProposalTarget, targetRefOf } from "./queries"
import { partyRole } from "./state"

/**
 * `proposals/expire` (§13, hourly): open proposals past `expires_at` become `expired` (final,
 * `closed_at` set), with `proposal.expired` (no actor) and a `proposal.expired` notification to
 * both parties. Each proposal is its own transaction with a conditional update (still open, still
 * past due), so an answer that lands first wins, and a second run, or a retried one, changes and
 * sends nothing (the notifications carry dedupe keys too).
 */

export const EXPIRE_BATCH_SIZE = 100

export type ExpireResult = { expired: number; checked: number; failed: number }

/** Expire one proposal if it is still open and due; true when this call expired it. */
export async function expireProposal(
  database: DbOrTx,
  proposalId: string,
  at: Date = now(),
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const updated = await tx
      .update(proposals)
      .set({ status: "expired", closedAt: at })
      .where(
        and(
          eq(proposals.id, proposalId),
          inArray(proposals.status, [...OPEN_PROPOSAL_STATUSES]),
          lte(proposals.expiresAt, at),
        ),
      )
      .returning({
        id: proposals.id,
        fromUserId: proposals.fromUserId,
        toUserId: proposals.toUserId,
        ideaId: proposals.ideaId,
        productId: proposals.productId,
        currentRevisionId: proposals.currentRevisionId,
      })
    const proposal = updated[0]
    if (!proposal) return false

    const [revision] = proposal.currentRevisionId
      ? await tx
          .select({ revisionNumber: proposalRevisions.revisionNumber })
          .from(proposalRevisions)
          .where(eq(proposalRevisions.id, proposal.currentRevisionId))
      : []
    await track(
      "proposal.expired",
      {
        actorUserId: null,
        subjectType: "proposal",
        subjectId: proposal.id,
        properties: { revision_number: revision?.revisionNumber ?? 1 },
      },
      tx,
    )
    const target = await loadProposalTarget(tx, targetRefOf(proposal))
    if (!target) throw new Error(`proposal ${proposal.id}: target not found`)
    const parties = [proposal.fromUserId, proposal.toUserId]
    const names = await loadPartyNames(
      tx,
      parties.map((userId) => ({ userId, role: partyRole(target, userId) })),
    )
    for (const recipientUserId of parties) {
      const counterpartId =
        recipientUserId === proposal.fromUserId ? proposal.toUserId : proposal.fromUserId
      await notifyProposalClosed(tx, "proposal.expired", {
        proposalId: proposal.id,
        recipientUserId,
        counterpartName: names.get(counterpartId)?.name ?? "Someone",
        target,
      })
    }
    return true
  }, database)
}

/**
 * Expire every open proposal due at `at`, oldest first, in batches. Walks by (expires_at, id), so a
 * proposal that fails to expire is reported to Sentry and skipped (the next hourly run tries it
 * again), never retried in a loop and never blocking the others. The job turns `failed > 0` into
 * a failed run (inngest/functions/proposals-expire.ts).
 */
export async function expireDueProposals(
  database: DbOrTx,
  options: { at?: Date; batchSize?: number } = {},
): Promise<ExpireResult> {
  const at = options.at ?? now()
  const batchSize = options.batchSize ?? EXPIRE_BATCH_SIZE
  let cursor: { expiresAt: Date; id: string } | null = null
  const result: ExpireResult = { expired: 0, checked: 0, failed: 0 }
  for (;;) {
    const due: { id: string; expiresAt: Date }[] = await database
      .select({ id: proposals.id, expiresAt: proposals.expiresAt })
      .from(proposals)
      .where(
        and(
          inArray(proposals.status, [...OPEN_PROPOSAL_STATUSES]),
          lte(proposals.expiresAt, at),
          cursor
            ? or(
                gt(proposals.expiresAt, cursor.expiresAt),
                and(eq(proposals.expiresAt, cursor.expiresAt), gt(proposals.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(proposals.expiresAt), asc(proposals.id))
      .limit(batchSize)
    for (const row of due) {
      result.checked += 1
      try {
        if (await expireProposal(database, row.id, at)) result.expired += 1
      } catch (error) {
        result.failed += 1
        reportError(error, { tags: { area: "proposals", job: "proposals-expire" } })
      }
    }
    const last = due.at(-1)
    if (!last || due.length < batchSize) return result
    cursor = { expiresAt: last.expiresAt, id: last.id }
  }
}

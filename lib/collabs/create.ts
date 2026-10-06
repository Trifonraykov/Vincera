import "server-only"

import { and, eq, ne } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { generateAgreement, type AgreementReadyNotice } from "@/lib/agreements/generate"
import type { Tx } from "@/lib/db/client"
import {
  agreements,
  builderProfiles,
  collabMembers,
  collabs,
  creatorProfiles,
  ideas,
  products,
  proposalRevisions,
  proposals,
  threads,
} from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { createThread } from "@/lib/threads/create"

/**
 * The function that runs when a proposal is accepted (CLAUDE.md §19.24 "Acceptance"). Owned by
 * "collab"; **called by "proposals"** inside the transaction that accepts the proposal:
 *
 *   1. proposals: lock the proposal, check the answer is allowed, set `status = 'accepted'`,
 *      `closed_at` (and `responded_at` if first), all in `tx`;
 *   2. proposals: `const { collabId } = await createCollabFromProposal(proposal.id, tx, { actorUserId })`;
 *   3. proposals: `track("proposal.accepted", { …, properties: { …, collab_id: collabId } }, tx)`,
 *      notify the other party (`proposal.accepted`), and mark the source match `proposed`.
 *
 * What it does:
 * - returns the existing collab (and its agreement in force) when the proposal already has one
 *   (`created: false`);
 * - checks the target is still available and moves it: an idea `open → in_collab`; a product stays
 *   `seeking` unless `exclusivity`, then `seeking → in_collab`. Otherwise it throws an
 *   `ActionError` ("This idea is no longer open …"), which rolls the acceptance back;
 * - inserts the collab (`stage = agreement`), both members with the current revision's splits
 *   (the idea's owner is the creator, the product's owner the builder; the other party takes the
 *   other role), the collab thread with both members (`createThread`), and `collab.created`;
 * - generates the agreement (lib/agreements/generate.ts: template v1 filled with the members and
 *   the accepted revision's scope and timeline, its rendered text and SHA-256, status
 *   `awaiting_signatures`, `agreement.generated`) and returns the `agreement.ready` notices for
 *   both members, which the caller sends after its commit (`sendAgreementReadyNotices`).
 */

export type CreateCollabResult = {
  collabId: string
  threadId: string
  /** False when the proposal already had a collab (a retried acceptance). */
  created: boolean
  /** The agreement in force (awaiting signatures on creation); null only for a collab made outside
   * this function without one (old test fixtures). */
  agreementId: string | null
  /**
   * The `agreement.ready` notices for a new collab (empty otherwise). The caller sends them with
   * `sendAgreementReadyNotices` after its transaction commits (CLAUDE.md §19.30).
   */
  readyNotices: AgreementReadyNotice[]
}

export async function createCollabFromProposal(
  proposalId: string,
  tx: Tx,
  options: { actorUserId: string },
): Promise<CreateCollabResult> {
  const [proposal] = await tx
    .select({
      id: proposals.id,
      status: proposals.status,
      fromUserId: proposals.fromUserId,
      toUserId: proposals.toUserId,
      ideaId: proposals.ideaId,
      productId: proposals.productId,
      creatorSplitPct: proposalRevisions.creatorSplitPct,
      builderSplitPct: proposalRevisions.builderSplitPct,
      scope: proposalRevisions.scope,
      timelineWeeks: proposalRevisions.timelineWeeks,
    })
    .from(proposals)
    .innerJoin(proposalRevisions, eq(proposalRevisions.id, proposals.currentRevisionId))
    .where(eq(proposals.id, proposalId))
    .for("update", { of: proposals })
  if (!proposal) throw new Error(`createCollabFromProposal: proposal ${proposalId} has no revision`)

  // Checked under the proposal's row lock, so concurrent calls cannot both create a collab.
  const [existing] = await tx
    .select({ collabId: collabs.id, threadId: threads.id, agreementId: agreements.id })
    .from(collabs)
    .leftJoin(threads, eq(threads.collabId, collabs.id))
    .leftJoin(
      agreements,
      and(eq(agreements.collabId, collabs.id), ne(agreements.status, "terminated")),
    )
    .where(eq(collabs.proposalId, proposalId))
  if (existing) {
    if (!existing.threadId) throw new Error(`collab ${existing.collabId} has no thread`)
    return {
      collabId: existing.collabId,
      threadId: existing.threadId,
      created: false,
      agreementId: existing.agreementId,
      readyNotices: [],
    }
  }
  if (proposal.status !== "accepted") {
    throw new Error(`createCollabFromProposal: proposal ${proposalId} is ${proposal.status}`)
  }

  const parties = [proposal.fromUserId, proposal.toUserId]
  const otherParty = (ownerUserId: string) => {
    if (!parties.includes(ownerUserId)) {
      throw new Error(`createCollabFromProposal: the target's owner is not a party`)
    }
    return ownerUserId === proposal.fromUserId ? proposal.toUserId : proposal.fromUserId
  }

  let creatorUserId: string
  let builderUserId: string
  let title: string
  if (proposal.ideaId) {
    const [idea] = await tx
      .select({ ownerUserId: creatorProfiles.userId, title: ideas.title })
      .from(ideas)
      .innerJoin(creatorProfiles, eq(creatorProfiles.id, ideas.creatorProfileId))
      .where(eq(ideas.id, proposal.ideaId))
    if (!idea) throw new Error(`createCollabFromProposal: idea ${proposal.ideaId} not found`)
    creatorUserId = idea.ownerUserId
    builderUserId = otherParty(idea.ownerUserId)
    title = idea.title
    const moved = await tx
      .update(ideas)
      .set({ status: "in_collab" })
      .where(and(eq(ideas.id, proposal.ideaId), eq(ideas.status, "open")))
      .returning({ id: ideas.id })
    if (moved.length === 0) {
      throw new ActionError("This idea is no longer open for a collaboration.")
    }
  } else if (proposal.productId) {
    const [product] = await tx
      .select({
        ownerUserId: builderProfiles.userId,
        title: products.title,
        status: products.status,
        exclusivity: products.exclusivity,
      })
      .from(products)
      .innerJoin(builderProfiles, eq(builderProfiles.id, products.builderProfileId))
      .where(eq(products.id, proposal.productId))
      .for("update", { of: products })
    if (!product)
      throw new Error(`createCollabFromProposal: product ${proposal.productId} not found`)
    builderUserId = product.ownerUserId
    creatorUserId = otherParty(product.ownerUserId)
    title = product.title
    if (product.status !== "seeking") {
      throw new ActionError("This product is no longer open for a collaboration.")
    }
    if (product.exclusivity) {
      await tx
        .update(products)
        .set({ status: "in_collab" })
        .where(eq(products.id, proposal.productId))
    }
  } else {
    throw new Error(`createCollabFromProposal: proposal ${proposalId} has no target`)
  }

  const [collab] = await tx
    .insert(collabs)
    .values({ proposalId, ideaId: proposal.ideaId, productId: proposal.productId })
    .returning({ id: collabs.id })
  if (!collab) throw new Error("createCollabFromProposal: no collab returned")

  const members = [
    { userId: creatorUserId, role: "creator" as const, splitPct: proposal.creatorSplitPct },
    { userId: builderUserId, role: "builder" as const, splitPct: proposal.builderSplitPct },
  ]
  await tx
    .insert(collabMembers)
    .values(members.map((member) => ({ collabId: collab.id, ...member })))
  const { threadId } = await createThread(tx, {
    kind: "collab",
    collabId: collab.id,
    participantUserIds: [creatorUserId, builderUserId],
  })
  await track(
    "collab.created",
    {
      actorUserId: options.actorUserId,
      subjectType: "collab",
      subjectId: collab.id,
      properties: {
        proposal_id: proposalId,
        idea_id: proposal.ideaId,
        product_id: proposal.productId,
      },
    },
    tx,
  )

  const { agreementId, readyNotices } = await generateAgreement(tx, {
    collabId: collab.id,
    collabTitle: title,
    members,
    scope: proposal.scope,
    timelineWeeks: proposal.timelineWeeks,
    actorUserId: options.actorUserId,
  })

  return { collabId: collab.id, threadId, created: true, agreementId, readyNotices }
}

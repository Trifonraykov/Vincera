import "server-only"

import { and, eq, inArray } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { ACTION_MESSAGES } from "@/lib/actions/result"
import {
  canRespondToProposal,
  canSendProposal,
  canWithdrawProposal,
  isProposalParty,
  OPEN_PROPOSAL_STATUSES,
  type AuthzUser,
} from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { sendAgreementReadyNotices } from "@/lib/agreements/generate"
import { createCollabFromProposal } from "@/lib/collabs/create"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { isPgError, PG_ERROR } from "@/lib/db/errors"
import type { MatchSnapshot } from "@/lib/db/schema/types"
import {
  matches,
  PROPOSAL_TTL_DAYS,
  proposalRevisions,
  proposals,
  type ProposalStatus,
} from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { rateLimit } from "@/lib/ratelimit"
import { createThread } from "@/lib/threads/create"

import type { ProposalTerms } from "./fields"
import {
  notifyProposalAccepted,
  notifyProposalClosed,
  notifyProposalCountered,
  notifyProposalReceived,
} from "./notifications"
import {
  findOpenProposalBetween,
  loadPartyNames,
  loadProposalState,
  loadProposalTarget,
  loadRecipient,
  targetRefOf,
  type ProposalState,
  type ProposalTargetInfo,
  type TargetRef,
} from "./queries"
import {
  isFinalProposalStatus,
  nextProposalStatus,
  otherPartyId,
  partyRole,
  sendBlockReason,
  type ProposalAction,
} from "./state"

/**
 * Proposal transitions (CLAUDE.md §19.24 "Proposals"): send, counter, accept, decline, withdraw.
 * Each runs in one transaction: the state change, its revision, the event (§11) and the
 * notification (last, because `notify` emails right away). Answers lock the proposal row
 * (`FOR UPDATE`) and write with a conditional update on the open statuses, so a racing answer,
 * withdrawal or expiry loses cleanly with a plain-language error.
 *
 * The server actions (./actions.ts) authorize with lib/auth/authz.ts first; these functions check
 * the same rules again under the lock, so they are safe to call on their own (tests, jobs).
 */

const DAY_MS = 24 * 60 * 60 * 1000

export const PROPOSAL_MESSAGES = {
  notFound: "We couldn't find that proposal.",
  targetNotFound: "We couldn't find that idea or product.",
  duplicate: "You already have an open proposal with them about this.",
  rateLimited:
    "You've sent 20 proposals today, the daily limit. You can send more tomorrow, or answer the ones you have.",
  stale: "The offer changed while you were looking. Check the new terms before you answer.",
  ownOffer:
    "This offer is yours, so it's their turn to answer. You can withdraw it if you changed your mind.",
  notYourOffer: "They answered your offer, so there's nothing to withdraw. See their answer below.",
  closed: {
    pending: "",
    countered: "",
    accepted: "This proposal was already accepted.",
    declined: "This proposal was declined.",
    expired: "This proposal expired.",
    withdrawn: "This proposal was withdrawn.",
  } satisfies Record<ProposalStatus, string>,
} as const

function expiresFrom(at: Date): Date {
  return new Date(at.getTime() + PROPOSAL_TTL_DAYS * DAY_MS)
}

function targetClosedMessage(target: Pick<ProposalTargetInfo, "kind">): string {
  return target.kind === "idea"
    ? "This idea isn't open for proposals any more. You can decline the proposal or let it expire."
    : "This product isn't looking for creators any more. You can decline the proposal or let it expire."
}

function isTargetOpen(target: Pick<ProposalTargetInfo, "kind" | "status">): boolean {
  return target.kind === "idea" ? target.status === "open" : target.status === "seeking"
}

// --- Send -----------------------------------------------------------------------------------------

export type SendProposalInput = {
  recipientId: string
  target: TargetRef
  /** The match the sender proposed from (`?match=`); ignored unless it is theirs and fits. */
  matchId: string | null
  terms: ProposalTerms
}

export type SendContext = {
  target: ProposalTargetInfo
  recipient: NonNullable<Awaited<ReturnType<typeof loadRecipient>>>
}

/** The target and the recipient of a proposal about to be sent; null when either is unknown. */
export async function loadSendContext(
  database: DbOrTx,
  input: Pick<SendProposalInput, "recipientId" | "target">,
  options: { lockForShare?: boolean } = {},
): Promise<SendContext | null> {
  const target = await loadProposalTarget(database, input.target, options)
  const recipient = target ? await loadRecipient(database, input.recipientId) : null
  return target && recipient ? { target, recipient } : null
}

/** Throws the plain-language reason when `sender` may not send this proposal. */
export function assertCanSend(sender: AuthzUser, context: SendContext | null): SendContext {
  if (!context) throw new ActionError(PROPOSAL_MESSAGES.targetNotFound)
  const reason = sendBlockReason(sender, context)
  if (reason) throw new ActionError(reason)
  if (!canSendProposal(sender, context)) throw new ActionError(ACTION_MESSAGES.forbidden)
  return context
}

/**
 * The match to link: the sender's own match about this target (an idea or product) or this
 * recipient (a creator or builder match). Anything else is dropped, never an error.
 */
async function linkableMatchId(
  tx: Tx,
  senderId: string,
  input: Pick<SendProposalInput, "matchId" | "recipientId" | "target">,
): Promise<{ id: string; snapshot: MatchSnapshot } | null> {
  if (!input.matchId) return null
  const [match] = await tx
    .select({
      id: matches.id,
      subjectUserId: matches.subjectUserId,
      targetType: matches.targetType,
      targetId: matches.targetId,
      modelVersion: matches.modelVersion,
      score: matches.score,
      features: matches.features,
      computedAt: matches.computedAt,
    })
    .from(matches)
    .where(eq(matches.id, input.matchId))
  if (!match || match.subjectUserId !== senderId) return null
  const fits =
    match.targetType === input.target.kind
      ? match.targetId === input.target.id
      : (match.targetType === "creator" || match.targetType === "builder") &&
        match.targetId === input.recipientId
  if (!fits) return null
  // Frozen at send time (CLAUDE.md §19.38): matching v1 trains on these pre-outcome features,
  // since every recompute rewrites the match row.
  return {
    id: match.id,
    snapshot: {
      modelVersion: match.modelVersion,
      score: match.score,
      features: match.features,
      computedAt: match.computedAt.toISOString(),
    },
  }
}

/**
 * Send a proposal (§12 `/app/proposals/new`): the proposal, revision 1, the thread, `proposal.sent`,
 * the source match marked `proposed`, and `proposal.received` to the recipient. Applies the
 * 20-per-day limit (§14) to new proposals only.
 */
export async function sendProposal(
  database: DbOrTx,
  sender: AuthzUser,
  input: SendProposalInput,
): Promise<{ proposalId: string; threadId: string; revisionId: string }> {
  // Plain-language refusals first, so a refused send never counts toward the daily limit.
  assertCanSend(sender, await loadSendContext(database, input))
  if (
    await findOpenProposalBetween(database, {
      userA: sender.id,
      userB: input.recipientId,
      target: input.target,
    })
  ) {
    throw new ActionError(PROPOSAL_MESSAGES.duplicate)
  }
  const limit = await rateLimit("proposals", sender.id)
  if (!limit.success) throw new ActionError(PROPOSAL_MESSAGES.rateLimited)

  try {
    return await withTransaction(async (tx) => {
      // Again under a share lock on the target, so it cannot be archived or taken meanwhile.
      const { target } = assertCanSend(
        sender,
        await loadSendContext(tx, input, { lockForShare: true }),
      )
      const linked = await linkableMatchId(tx, sender.id, input)
      const matchId = linked?.id ?? null
      const sentAt = now()
      const [proposal] = await tx
        .insert(proposals)
        .values({
          fromUserId: sender.id,
          toUserId: input.recipientId,
          ideaId: target.kind === "idea" ? target.id : null,
          productId: target.kind === "product" ? target.id : null,
          status: "pending",
          matchId,
          matchSnapshot: linked?.snapshot ?? null,
          expiresAt: expiresFrom(sentAt),
        })
        .returning({ id: proposals.id, expiresAt: proposals.expiresAt })
      if (!proposal) throw new Error("sendProposal: no proposal returned")
      const [revision] = await tx
        .insert(proposalRevisions)
        .values({
          proposalId: proposal.id,
          authorUserId: sender.id,
          revisionNumber: 1,
          ...revisionTerms(input.terms),
        })
        .returning({ id: proposalRevisions.id })
      if (!revision) throw new Error("sendProposal: no revision returned")
      await tx
        .update(proposals)
        .set({ currentRevisionId: revision.id })
        .where(eq(proposals.id, proposal.id))
      const { threadId } = await createThread(tx, {
        kind: "proposal",
        proposalId: proposal.id,
        participantUserIds: [sender.id, input.recipientId],
      })
      if (matchId) {
        await tx.update(matches).set({ status: "proposed" }).where(eq(matches.id, matchId))
      }
      await track(
        "proposal.sent",
        {
          actorUserId: sender.id,
          subjectType: "proposal",
          subjectId: proposal.id,
          properties: {
            ...termProperties(1, input.terms),
            to_user_id: input.recipientId,
            target: target.kind,
            target_id: target.id,
            match_id: matchId,
          },
        },
        tx,
      )
      const senderName = await partyName(tx, target, sender.id)
      await notifyProposalReceived(
        tx,
        {
          proposalId: proposal.id,
          recipientUserId: input.recipientId,
          counterpartName: senderName,
          target,
        },
        { terms: input.terms, expiresAt: proposal.expiresAt },
      )
      return { proposalId: proposal.id, threadId, revisionId: revision.id }
    }, database)
  } catch (error) {
    // Two sends racing past the check above: the partial unique index keeps one.
    if (isPgError(error, PG_ERROR.uniqueViolation, "proposals_one_open_per_pair_target_idx")) {
      throw new ActionError(PROPOSAL_MESSAGES.duplicate)
    }
    throw error
  }
}

function revisionTerms(terms: ProposalTerms) {
  return {
    message: terms.message,
    scope: terms.scope,
    creatorSplitPct: terms.creatorSplitPct,
    builderSplitPct: terms.builderSplitPct,
    timelineWeeks: terms.timelineWeeks,
  }
}

function termProperties(
  revisionNumber: number,
  terms: Pick<ProposalTerms, "creatorSplitPct" | "builderSplitPct" | "timelineWeeks">,
) {
  return {
    revision_number: revisionNumber,
    creator_split_pct: terms.creatorSplitPct,
    builder_split_pct: terms.builderSplitPct,
    timeline_weeks: terms.timelineWeeks,
  }
}

async function partyName(tx: Tx, target: ProposalTargetInfo, userId: string): Promise<string> {
  const names = await loadPartyNames(tx, [{ userId, role: partyRole(target, userId) }])
  return names.get(userId)?.name ?? "Someone"
}

// --- Answers --------------------------------------------------------------------------------------

/** Lock the proposal and check that `user` may take `action` on the offer `revisionId`. */
async function lockForAnswer(
  tx: Tx,
  user: AuthzUser,
  input: { proposalId: string; revisionId?: string },
  action: Exclude<ProposalAction, "expire">,
): Promise<{ state: ProposalState; next: ProposalStatus }> {
  const state = await loadProposalState(tx, input.proposalId, { lockForUpdate: true })
  if (!state || !isProposalParty(user, state)) throw new ActionError(PROPOSAL_MESSAGES.notFound)
  const next = nextProposalStatus(state.status, action)
  if (!next || isFinalProposalStatus(state.status)) {
    throw new ActionError(PROPOSAL_MESSAGES.closed[state.status] || ACTION_MESSAGES.forbidden)
  }
  // Past its expiry but not yet swept by the hourly job: it is over all the same.
  if (state.expiresAt.getTime() <= now().getTime()) {
    throw new ActionError(PROPOSAL_MESSAGES.closed.expired)
  }
  if (action === "withdraw") {
    if (!canWithdrawProposal(user, state)) throw new ActionError(PROPOSAL_MESSAGES.notYourOffer)
  } else {
    if (state.currentRevisionAuthorId === user.id) throw new ActionError(PROPOSAL_MESSAGES.ownOffer)
    if (!canRespondToProposal(user, state)) throw new ActionError(ACTION_MESSAGES.forbidden)
  }
  if (input.revisionId !== undefined && input.revisionId !== state.currentRevisionId) {
    throw new ActionError(PROPOSAL_MESSAGES.stale)
  }
  return { state, next }
}

/**
 * Write the new status, conditional on the proposal still being open on the same offer (the row
 * is locked, so this only fails if something bypassed the lock).
 */
async function writeTransition(
  tx: Tx,
  state: ProposalState,
  values: Partial<typeof proposals.$inferInsert> & { status: ProposalStatus },
): Promise<void> {
  const conditions = [
    eq(proposals.id, state.id),
    inArray(proposals.status, [...OPEN_PROPOSAL_STATUSES]),
  ]
  if (state.currentRevisionId)
    conditions.push(eq(proposals.currentRevisionId, state.currentRevisionId))
  const updated = await tx
    .update(proposals)
    .set(values)
    .where(and(...conditions))
    .returning({ id: proposals.id })
  if (updated.length === 0) throw new ActionError(PROPOSAL_MESSAGES.stale)
}

/** `responded_at`: the recipient's first answer (counter, accept or decline). */
function respondedAt(state: ProposalState, user: AuthzUser, at: Date): Date | null {
  return state.respondedAt ?? (user.id === state.toUserId ? at : null)
}

async function loadCurrentTerms(tx: Tx, revisionId: string | null) {
  if (!revisionId) throw new Error("proposal has no current revision")
  const [revision] = await tx
    .select({
      revisionNumber: proposalRevisions.revisionNumber,
      creatorSplitPct: proposalRevisions.creatorSplitPct,
      builderSplitPct: proposalRevisions.builderSplitPct,
      timelineWeeks: proposalRevisions.timelineWeeks,
    })
    .from(proposalRevisions)
    .where(eq(proposalRevisions.id, revisionId))
  if (!revision) throw new Error(`revision ${revisionId} not found`)
  return revision
}

async function targetOf(tx: Tx, state: ProposalState): Promise<ProposalTargetInfo> {
  const target = await loadProposalTarget(tx, targetRefOf(state))
  if (!target) throw new Error(`proposal ${state.id}: target not found`)
  return target
}

export type CounterProposalInput = {
  proposalId: string
  /** The offer the user is answering (the page's current revision). */
  revisionId: string
  terms: ProposalTerms
}

/** Counter-offer: revision n + 1 with the new terms; the proposal becomes `countered`. */
export async function counterProposal(
  database: DbOrTx,
  user: AuthzUser,
  input: CounterProposalInput,
): Promise<{ revisionId: string; revisionNumber: number }> {
  return withTransaction(async (tx) => {
    const { state, next } = await lockForAnswer(tx, user, input, "counter")
    const target = await loadProposalTarget(tx, targetRefOf(state), { lockForShare: true })
    if (!target) throw new Error(`proposal ${state.id}: target not found`)
    if (!isTargetOpen(target)) throw new ActionError(targetClosedMessage(target))

    const at = now()
    const revisionNumber = (state.currentRevisionNumber ?? 0) + 1
    const [revision] = await tx
      .insert(proposalRevisions)
      .values({
        proposalId: state.id,
        authorUserId: user.id,
        revisionNumber,
        ...revisionTerms(input.terms),
      })
      .returning({ id: proposalRevisions.id })
    if (!revision) throw new Error("counterProposal: no revision returned")
    const expiresAt = expiresFrom(at)
    await writeTransition(tx, state, {
      status: next,
      currentRevisionId: revision.id,
      // Every counter gives the other party a fresh 14 days (§19.24).
      expiresAt,
      respondedAt: respondedAt(state, user, at),
    })
    await track(
      "proposal.countered",
      {
        actorUserId: user.id,
        subjectType: "proposal",
        subjectId: state.id,
        properties: termProperties(revisionNumber, input.terms),
      },
      tx,
    )
    await notifyProposalCountered(
      tx,
      {
        proposalId: state.id,
        recipientUserId: otherPartyId(state, user.id),
        counterpartName: await partyName(tx, target, user.id),
        target,
      },
      { terms: input.terms, revisionNumber, expiresAt },
    )
    return { revisionId: revision.id, revisionNumber }
  }, database)
}

/**
 * Accept the offer on the table: `accepted`, then the collab (`createCollabFromProposal`: the
 * target moves to `in_collab`, members, thread, `collab.created`), `proposal.accepted` and the
 * notification, all in one transaction. A target that is no longer available rolls it all back.
 * The `agreement.ready` notices go out after the commit (CLAUDE.md §19.30).
 */
export async function acceptProposal(
  database: DbOrTx,
  user: AuthzUser,
  input: { proposalId: string; revisionId: string },
): Promise<{ collabId: string }> {
  const { collabId, readyNotices } = await withTransaction(async (tx) => {
    const { state, next } = await lockForAnswer(tx, user, input, "accept")
    const at = now()
    await writeTransition(tx, state, {
      status: next,
      closedAt: at,
      respondedAt: respondedAt(state, user, at),
    })
    const { collabId, readyNotices } = await createCollabFromProposal(state.id, tx, {
      actorUserId: user.id,
    })
    const terms = await loadCurrentTerms(tx, state.currentRevisionId)
    await track(
      "proposal.accepted",
      {
        actorUserId: user.id,
        subjectType: "proposal",
        subjectId: state.id,
        properties: { ...termProperties(terms.revisionNumber, terms), collab_id: collabId },
      },
      tx,
    )
    const target = await targetOf(tx, state)
    await notifyProposalAccepted(
      tx,
      {
        proposalId: state.id,
        recipientUserId: otherPartyId(state, user.id),
        counterpartName: await partyName(tx, target, user.id),
        target,
      },
      { terms, collabId },
    )
    return { collabId, readyNotices }
  }, database)
  // After the commit: nobody is told to sign an agreement whose acceptance rolled back.
  await sendAgreementReadyNotices(database, readyNotices)
  return { collabId }
}

/** Decline the offer on the table: `declined`, final. */
export async function declineProposal(
  database: DbOrTx,
  user: AuthzUser,
  input: { proposalId: string; revisionId?: string },
): Promise<void> {
  await withTransaction(async (tx) => {
    const { state, next } = await lockForAnswer(tx, user, input, "decline")
    const at = now()
    await writeTransition(tx, state, {
      status: next,
      closedAt: at,
      respondedAt: respondedAt(state, user, at),
    })
    await closeWithNotice(tx, state, user, "proposal.declined")
  }, database)
}

/** Withdraw your own offer while it waits for an answer: `withdrawn`, final. */
export async function withdrawProposal(
  database: DbOrTx,
  user: AuthzUser,
  input: { proposalId: string },
): Promise<void> {
  await withTransaction(async (tx) => {
    const { state, next } = await lockForAnswer(tx, user, input, "withdraw")
    await writeTransition(tx, state, { status: next, closedAt: now() })
    await closeWithNotice(tx, state, user, "proposal.withdrawn")
  }, database)
}

async function closeWithNotice(
  tx: Tx,
  state: ProposalState,
  user: AuthzUser,
  type: "proposal.declined" | "proposal.withdrawn",
): Promise<void> {
  await track(
    type,
    {
      actorUserId: user.id,
      subjectType: "proposal",
      subjectId: state.id,
      properties: { revision_number: state.currentRevisionNumber ?? 1 },
    },
    tx,
  )
  const target = await targetOf(tx, state)
  await notifyProposalClosed(tx, type, {
    proposalId: state.id,
    recipientUserId: otherPartyId(state, user.id),
    counterpartName: await partyName(tx, target, user.id),
    target,
  })
}

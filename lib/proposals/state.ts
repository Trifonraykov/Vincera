import {
  canRespondToProposal,
  canWithdrawProposal,
  hasCompletedOnboarding,
  hasRole,
  isActive,
  type AuthzUser,
  type ProposalAccess,
  type ProposalRecipient,
  type ProposalTarget,
} from "@/lib/auth/authz"
import type { CollabRole, ProposalStatus } from "@/lib/db/schema/enums"

/**
 * The proposal state machine (CLAUDE.md §19.24 "Proposals"), pure and client-safe so the pages,
 * the server code and the unit tests share one definition.
 *
 * `pending` and `countered` are open; `accepted`, `declined`, `expired` and `withdrawn` are final.
 * From an open status: the party who did **not** make the offer on the table counters, accepts or
 * declines; the party who made it withdraws; the hourly job expires it. Nothing leaves a final
 * status. Who may act is decided by the rules in lib/auth/authz.ts (`canRespondToProposal`,
 * `canWithdrawProposal`); this module says where each action leads.
 */

export type ProposalAction = "counter" | "accept" | "decline" | "withdraw" | "expire"

export const PROPOSAL_ACTIONS = [
  "counter",
  "accept",
  "decline",
  "withdraw",
  "expire",
] as const satisfies readonly ProposalAction[]

export const FINAL_PROPOSAL_STATUSES = [
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const satisfies readonly ProposalStatus[]

const FROM_OPEN = {
  counter: "countered",
  accept: "accepted",
  decline: "declined",
  withdraw: "withdrawn",
  expire: "expired",
} as const satisfies Record<ProposalAction, ProposalStatus>

/** Status → action → next status. Missing entries are illegal transitions. */
export const PROPOSAL_TRANSITIONS: Record<
  ProposalStatus,
  Partial<Record<ProposalAction, ProposalStatus>>
> = {
  pending: FROM_OPEN,
  countered: FROM_OPEN,
  accepted: {},
  declined: {},
  expired: {},
  withdrawn: {},
}

/** Where `action` takes a proposal in `status`, or null when the transition is not allowed. */
export function nextProposalStatus(
  status: ProposalStatus,
  action: ProposalAction,
): ProposalStatus | null {
  return PROPOSAL_TRANSITIONS[status][action] ?? null
}

export function isFinalProposalStatus(status: ProposalStatus): boolean {
  return (FINAL_PROPOSAL_STATUSES as readonly string[]).includes(status)
}

/** Who performs an action: the party awaiting an answer, the current offer's author, or the job. */
export const PROPOSAL_ACTION_ACTOR: Record<ProposalAction, "awaiting" | "author" | "system"> = {
  counter: "awaiting",
  accept: "awaiting",
  decline: "awaiting",
  withdraw: "author",
  expire: "system",
}

/** The actions `user` may take on the proposal now, in the order the page offers them. */
export function proposalActionsFor(user: AuthzUser, proposal: ProposalAccess): ProposalAction[] {
  const actions: ProposalAction[] = []
  if (canRespondToProposal(user, proposal)) actions.push("accept", "counter", "decline")
  if (canWithdrawProposal(user, proposal)) actions.push("withdraw")
  return actions
}

/** The party who has to answer the offer on the table, or null once the proposal is closed. */
export function awaitingPartyId(proposal: ProposalAccess): string | null {
  if (isFinalProposalStatus(proposal.status) || proposal.currentRevisionAuthorId === null) {
    return null
  }
  return proposal.currentRevisionAuthorId === proposal.fromUserId
    ? proposal.toUserId
    : proposal.fromUserId
}

/** The other party of a proposal, from `userId`'s point of view. */
export function otherPartyId(
  proposal: Pick<ProposalAccess, "fromUserId" | "toUserId">,
  userId: string,
): string {
  return proposal.fromUserId === userId ? proposal.toUserId : proposal.fromUserId
}

/**
 * Each party's role in the deal: the idea's owner is the creator and a product's owner the
 * builder; the other party takes the other role (the same rule as `createCollabFromProposal`).
 */
export function partyRole(
  target: Pick<ProposalTarget, "kind" | "ownerUserId">,
  userId: string,
): CollabRole {
  const ownerRole: CollabRole = target.kind === "idea" ? "creator" : "builder"
  const otherRole: CollabRole = target.kind === "idea" ? "builder" : "creator"
  return userId === target.ownerUserId ? ownerRole : otherRole
}

// --- Sending ------------------------------------------------------------------------------------

/**
 * Why `user` may not send a proposal about `target` to `recipient`, in plain language, or null
 * when nothing stands in the way. It mirrors `canSendProposal` (lib/auth/authz.ts), which stays the
 * rule every send is checked against; this only explains a refusal to the sender.
 */
export function sendBlockReason(
  user: AuthzUser,
  input: { target: ProposalTarget; recipient: ProposalRecipient },
): string | null {
  const { target, recipient } = input
  if (!isActive(user)) return "Your account can't send proposals right now."
  if (!hasCompletedOnboarding(user)) {
    return "Finish setting up your account before you send a proposal."
  }
  if (recipient.id === user.id) return "You can't send a proposal to yourself."
  if (!isActive(recipient)) return "This person isn't taking proposals right now."
  if (!hasCompletedOnboarding(recipient)) {
    return "This person hasn't finished setting up their account yet, so they can't answer."
  }
  const noun = target.kind === "idea" ? "idea" : "product"
  if (target.ownerUserId !== user.id && target.ownerUserId !== recipient.id) {
    return `This ${noun} belongs to someone else. Send your proposal to its owner.`
  }
  const ownerRole = target.kind === "idea" ? "creator" : "builder"
  const counterpartRole = target.kind === "idea" ? "builder" : "creator"
  const owner = target.ownerUserId === user.id ? user : recipient
  const counterpart = target.ownerUserId === user.id ? recipient : user
  if (!hasRole(owner, ownerRole)) return `Only a ${ownerRole} can make a deal about this ${noun}.`
  if (!hasRole(counterpart, counterpartRole)) {
    return counterpart.id === user.id
      ? `Proposals about ${noun}s come from ${counterpartRole}s. Add the ${counterpartRole} role to send one.`
      : `${target.kind === "idea" ? "Ideas" : "Products"} are offered to ${counterpartRole}s, and this person isn't one.`
  }
  if (target.kind === "idea" && target.status !== "open") {
    return "This idea isn't open for proposals."
  }
  if (target.kind === "product" && target.status !== "seeking") {
    return "This product isn't looking for creators right now."
  }
  return null
}

"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import {
  canRespondToProposal,
  canSendProposal,
  canWithdrawProposal,
  isProposalParty,
  type AuthzUser,
} from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"

import { proposalTermsFields, withSplitCheck } from "./fields"
import { loadProposalState } from "./queries"
import {
  acceptProposal,
  assertCanSend,
  counterProposal,
  declineProposal,
  loadSendContext,
  PROPOSAL_MESSAGES,
  sendProposal,
  withdrawProposal,
} from "./service"
import { isFinalProposalStatus } from "./state"

/**
 * Proposal server actions (§4: Zod input, `requireUser`, an authz rule, a transaction, events).
 * The work is in ./service.ts, which checks the rules again under the proposal's row lock. A
 * refusal the user can do something about comes back as a plain-language message.
 */

const id = (what: string) => z.uuid({ error: `That ${what} link is not valid.` })
const optionalId = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.uuid().optional(),
)

/** Everything under /app shows proposal state (lists, home, the shell's counts). */
function revalidateProposalPages(): void {
  revalidatePath("/app", "layout")
}

const sendInput = withSplitCheck(
  z.object({
    ...proposalTermsFields,
    to: id("person"),
    targetKind: z.enum(["idea", "product"], { error: "Pick an idea or a product." }),
    targetId: id("idea or product"),
    match: optionalId,
  }),
)

/** `/app/proposals/new`: send the proposal, then open it. */
export const sendProposalAction = defineAction({
  name: "proposals.send",
  input: sendInput,
  authorize: async (user, input) => {
    const context = await loadSendContext(getDb(), {
      recipientId: input.to,
      target: { kind: input.targetKind, id: input.targetId },
    })
    // Throws the plain-language reason (not onboarded, target closed, …) for the form.
    return canSendProposal(user, assertCanSend(user, context))
  },
  run: async ({ input, user, db }) => {
    const { proposalId } = await sendProposal(db, user, {
      recipientId: input.to,
      target: { kind: input.targetKind, id: input.targetId },
      matchId: input.match ?? null,
      terms: input,
    })
    revalidateProposalPages()
    redirect(`/app/proposals/${proposalId}?sent=1`)
  },
})

/**
 * Who may answer: explains closed proposals and "it's their turn" instead of a bare refusal. The
 * service checks again under the lock.
 */
async function authorizeAnswer(
  user: AuthzUser,
  proposalId: string,
  kind: "respond" | "withdraw",
): Promise<boolean> {
  const state = await loadProposalState(getDb(), proposalId)
  if (!state || !isProposalParty(user, state)) throw new ActionError(PROPOSAL_MESSAGES.notFound)
  if (isFinalProposalStatus(state.status)) {
    throw new ActionError(PROPOSAL_MESSAGES.closed[state.status])
  }
  if (kind === "withdraw") {
    if (state.currentRevisionAuthorId !== user.id) {
      throw new ActionError(PROPOSAL_MESSAGES.notYourOffer)
    }
    return canWithdrawProposal(user, state)
  }
  if (state.currentRevisionAuthorId === user.id) throw new ActionError(PROPOSAL_MESSAGES.ownOffer)
  return canRespondToProposal(user, state)
}

const counterInput = withSplitCheck(
  z.object({
    ...proposalTermsFields,
    proposalId: id("proposal"),
    revisionId: id("offer"),
  }),
)

export const counterProposalAction = defineAction({
  name: "proposals.counter",
  input: counterInput,
  authorize: (user, input) => authorizeAnswer(user, input.proposalId, "respond"),
  run: async ({ input, user, db }) => {
    const result = await counterProposal(db, user, {
      proposalId: input.proposalId,
      revisionId: input.revisionId,
      terms: input,
    })
    revalidateProposalPages()
    return result
  },
})

const answerInput = z.object({ proposalId: id("proposal"), revisionId: id("offer") })

export const acceptProposalAction = defineAction({
  name: "proposals.accept",
  input: answerInput,
  authorize: (user, input) => authorizeAnswer(user, input.proposalId, "respond"),
  run: async ({ input, user, db }) => {
    const result = await acceptProposal(db, user, input)
    revalidateProposalPages()
    return result
  },
})

export const declineProposalAction = defineAction({
  name: "proposals.decline",
  input: answerInput,
  authorize: (user, input) => authorizeAnswer(user, input.proposalId, "respond"),
  run: async ({ input, user, db }) => {
    await declineProposal(db, user, input)
    revalidateProposalPages()
    return { declined: true as const }
  },
})

export const withdrawProposalAction = defineAction({
  name: "proposals.withdraw",
  input: z.object({ proposalId: id("proposal") }),
  authorize: (user, input) => authorizeAnswer(user, input.proposalId, "withdraw"),
  run: async ({ input, user, db }) => {
    await withdrawProposal(db, user, input)
    revalidateProposalPages()
    return { withdrawn: true as const }
  },
})

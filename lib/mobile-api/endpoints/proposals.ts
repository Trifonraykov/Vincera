import "server-only"

import { z } from "zod"

import { ActionError } from "@/lib/actions/errors"
import {
  canManageOwnAccount,
  canRespondToProposal,
  canSendProposal,
  canViewProposal,
  canWithdrawProposal,
  isProposalParty,
} from "@/lib/auth/authz"
import type { AuthUser } from "@/lib/auth/user"
import { now } from "@/lib/clock"
import type { Db } from "@/lib/db/client"
import { proposalTermsSchema } from "@/lib/proposals/fields"
import {
  countProposalTabs,
  listProposals,
  loadProposalDetail,
  loadProposalState,
  proposalCursorAfter,
} from "@/lib/proposals/queries"
import {
  acceptProposal,
  assertCanSend,
  counterProposal,
  declineProposal,
  loadSendContext,
  PROPOSAL_MESSAGES,
  sendProposal,
  withdrawProposal,
} from "@/lib/proposals/service"
import { awaitingPartyId, isFinalProposalStatus, proposalActionsFor } from "@/lib/proposals/state"

import { revalidateApp } from "../context"
import { forbidden, MobileApiError } from "../errors"
import { endpoint, parseForm, uuidParam, type Endpoint } from "../router"
import {
  PROPOSAL_TAB_VALUES,
  answerProposalInput,
  counterProposalInput,
  proposalChangedOutput,
  proposalDetailSchema,
  proposalListOutput,
  sendProposalInput,
} from "../schemas"

/**
 * Proposals (§12 `/app/proposals/*`; CLAUDE.md §19.26). Sending and answering call the services
 * the web's server actions call (lib/proposals/service.ts), which check the rules again under the
 * proposal's row lock, write the revision, events and notifications, and apply the 20-per-day
 * limit to new proposals (§14). The up-front checks below give the same plain-language reasons as
 * the web's `authorize` steps.
 */

/** `<iso>_<uuid>`, the same keyset cursor as the web's `?before=`. */
const cursorQuery = z
  .string()
  .regex(/^[^_]+_[0-9a-f-]{36}$/)
  .transform((value) => {
    const [at = "", id = ""] = value.split("_")
    return { at: new Date(at), id }
  })
  .refine((cursor) => !Number.isNaN(cursor.at.getTime()))

const notFoundProposal = () => new MobileApiError(404, "not_found", PROPOSAL_MESSAGES.notFound)

/** The web's `authorizeAnswer` (lib/proposals/actions.ts): who may answer or withdraw now. */
async function authorizeAnswer(
  db: Db,
  user: AuthUser,
  proposalId: string,
  kind: "respond" | "withdraw",
): Promise<void> {
  const state = await loadProposalState(db, proposalId)
  if (!state || !isProposalParty(user, state)) throw notFoundProposal()
  if (isFinalProposalStatus(state.status)) {
    throw new ActionError(PROPOSAL_MESSAGES.closed[state.status])
  }
  if (kind === "withdraw") {
    if (state.currentRevisionAuthorId !== user.id) {
      throw new ActionError(PROPOSAL_MESSAGES.notYourOffer)
    }
    if (!canWithdrawProposal(user, state)) throw forbidden()
    return
  }
  if (state.currentRevisionAuthorId === user.id) throw new ActionError(PROPOSAL_MESSAGES.ownOffer)
  if (!canRespondToProposal(user, state)) throw forbidden()
}

export const proposalEndpoints: Endpoint[] = [
  endpoint({
    method: "GET",
    path: "/proposals",
    auth: "onboarded",
    query: z.object({
      tab: z.enum(PROPOSAL_TAB_VALUES).default("received"),
      before: cursorQuery.optional(),
    }),
    output: proposalListOutput,
    run: async ({ db, user, query }) => {
      if (!canManageOwnAccount(user)) throw forbidden()
      const [page, counts] = await Promise.all([
        listProposals(db, user.id, query.tab, { before: query.before }),
        countProposalTabs(db, user.id),
      ])
      const last = page.items.at(-1)
      const cursor = page.hasMore && last ? proposalCursorAfter(last, query.tab) : null
      return {
        tab: query.tab,
        counts,
        items: page.items,
        nextCursor: cursor ? `${cursor.at.toISOString()}_${cursor.id}` : null,
      }
    },
  }),
  endpoint({
    method: "GET",
    path: "/proposals/:id",
    auth: "onboarded",
    output: proposalDetailSchema,
    run: async ({ db, user, params }) => {
      const detail = await loadProposalDetail(db, uuidParam(params))
      // Parties and admins (read-only) only; anyone else learns nothing (§6).
      if (!detail || !canViewProposal(user, detail.access)) throw notFoundProposal()
      const lapsed = detail.closedAt === null && detail.expiresAt.getTime() <= now().getTime()
      return {
        id: detail.id,
        status: lapsed ? "expired" : detail.status,
        lapsed,
        createdAt: detail.createdAt,
        expiresAt: detail.expiresAt,
        closedAt: detail.closedAt,
        fromUserId: detail.fromUserId,
        toUserId: detail.toUserId,
        target: { kind: detail.target.kind, id: detail.target.id, title: detail.target.title },
        parties: [...detail.parties.values()],
        currentRevisionId: detail.currentRevisionId,
        revisions: detail.revisions,
        actions: lapsed ? [] : proposalActionsFor(user, detail.access),
        awaitingUserId: lapsed ? null : awaitingPartyId(detail.access),
        threadId: detail.threadId,
        collabId: detail.collabId,
      }
    },
  }),
  endpoint({
    method: "POST",
    path: "/proposals",
    auth: "onboarded",
    input: sendProposalInput,
    output: proposalChangedOutput,
    run: async ({ db, user, input }) => {
      const terms = parseForm(proposalTermsSchema, input)
      const target = { kind: input.targetKind, id: input.targetId }
      const context = await loadSendContext(db, { recipientId: input.to, target })
      // Throws the plain-language reason (not onboarded, target closed, …), as on the web.
      if (!canSendProposal(user, assertCanSend(user, context))) throw forbidden()
      const result = await sendProposal(db, user, {
        recipientId: input.to,
        target,
        matchId: input.matchId ?? null,
        terms,
      })
      revalidateApp()
      return { proposalId: result.proposalId, status: "pending", collabId: null }
    },
  }),
  endpoint({
    method: "POST",
    path: "/proposals/:id/counter",
    auth: "onboarded",
    input: counterProposalInput,
    output: proposalChangedOutput,
    run: async ({ db, user, params, input }) => {
      const proposalId = uuidParam(params)
      await authorizeAnswer(db, user, proposalId, "respond")
      const terms = parseForm(proposalTermsSchema, input)
      await counterProposal(db, user, { proposalId, revisionId: input.revisionId, terms })
      revalidateApp()
      return { proposalId, status: "countered", collabId: null }
    },
  }),
  endpoint({
    method: "POST",
    path: "/proposals/:id/accept",
    auth: "onboarded",
    input: answerProposalInput,
    output: proposalChangedOutput,
    run: async ({ db, user, params, input }) => {
      const proposalId = uuidParam(params)
      await authorizeAnswer(db, user, proposalId, "respond")
      const result = await acceptProposal(db, user, { proposalId, revisionId: input.revisionId })
      revalidateApp()
      return { proposalId, status: "accepted", collabId: result.collabId }
    },
  }),
  endpoint({
    method: "POST",
    path: "/proposals/:id/decline",
    auth: "onboarded",
    input: answerProposalInput,
    output: proposalChangedOutput,
    run: async ({ db, user, params, input }) => {
      const proposalId = uuidParam(params)
      await authorizeAnswer(db, user, proposalId, "respond")
      await declineProposal(db, user, { proposalId, revisionId: input.revisionId })
      revalidateApp()
      return { proposalId, status: "declined", collabId: null }
    },
  }),
  endpoint({
    method: "POST",
    path: "/proposals/:id/withdraw",
    auth: "onboarded",
    output: proposalChangedOutput,
    run: async ({ db, user, params }) => {
      const proposalId = uuidParam(params)
      await authorizeAnswer(db, user, proposalId, "withdraw")
      await withdrawProposal(db, user, { proposalId })
      revalidateApp()
      return { proposalId, status: "withdrawn", collabId: null }
    },
  }),
]

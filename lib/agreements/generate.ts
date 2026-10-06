import "server-only"

import { now } from "@/lib/clock"
import { loadPayoutsReadiness } from "@/lib/collabs/queries"
import { notifyAgreementReady } from "@/lib/collabs/notifications"
import type { DbOrTx, Tx } from "@/lib/db/client"
import { agreements, type CollabRole } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { newId } from "@/lib/ids"
import { reportError } from "@/lib/observability"
import { loadPartyNames } from "@/lib/proposals/queries"

import { agreementBodyHash } from "./integrity"
import { AGREEMENT_TEMPLATE_V1, buildTermsV1, renderAgreementV1 } from "./template-v1"

/**
 * Generate a collab's agreement (§12 "Agreement page", CLAUDE.md §19.24 "Agreement"): the terms
 * snapshot (members' names and splits, the accepted revision's scope and timeline, the v1
 * clauses), the rendered text and its SHA-256, status `awaiting_signatures`; `agreement.generated`.
 * Runs inside the transaction that creates the collab (`createCollabFromProposal`), so the
 * agreement exists exactly when the collab does.
 *
 * The `agreement.ready` notices (email: agreement-ready.tsx) are returned, not sent: `notify`
 * emails at once, so the caller sends them with `sendAgreementReadyNotices` after its transaction
 * commits. Sent from inside it, a later failure would roll the collab back after both people were
 * told to sign it (CLAUDE.md §19.30).
 */

export type GenerateAgreementInput = {
  collabId: string
  /** The idea's or product's title (notifications). */
  collabTitle: string
  members: readonly { userId: string; role: CollabRole; splitPct: number }[]
  scope: string
  timelineWeeks: number
  /** Who caused it (the member who accepted the proposal); null for jobs and the seed. */
  actorUserId: string | null
}

const FALLBACK_NAMES: Record<CollabRole, string> = { creator: "A creator", builder: "A builder" }

export type AgreementReadyNotice = Parameters<typeof notifyAgreementReady>[1]

export async function generateAgreement(
  tx: Tx,
  input: GenerateAgreementInput,
): Promise<{ agreementId: string; readyNotices: AgreementReadyNotice[] }> {
  const names = await loadPartyNames(tx, input.members)
  const terms = buildTermsV1({
    parties: input.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      splitPct: member.splitPct,
      name: names.get(member.userId)?.name ?? FALLBACK_NAMES[member.role],
    })),
    scope: input.scope,
    timelineWeeks: input.timelineWeeks,
  })
  const at = now()
  const agreementId = newId()
  const renderedBody = renderAgreementV1(terms, { collabId: input.collabId, generatedAt: at })
  await tx.insert(agreements).values({
    id: agreementId,
    collabId: input.collabId,
    templateVersion: AGREEMENT_TEMPLATE_V1,
    terms,
    renderedBody,
    bodyHash: agreementBodyHash(renderedBody),
    status: "awaiting_signatures",
    createdAt: at,
    updatedAt: at,
  })
  await track(
    "agreement.generated",
    {
      actorUserId: input.actorUserId,
      subjectType: "agreement",
      subjectId: agreementId,
      properties: { collab_id: input.collabId, template_version: AGREEMENT_TEMPLATE_V1 },
      occurredAt: at,
    },
    tx,
  )

  const creator = terms.parties.find((party) => party.role === "creator")
  const builder = terms.parties.find((party) => party.role === "builder")
  const splits = {
    creatorSplitPct: creator?.splitPct ?? 0,
    builderSplitPct: builder?.splitPct ?? 0,
    timelineWeeks: terms.timelineWeeks,
  }
  const readiness = await loadPayoutsReadiness(
    tx,
    terms.parties.map((party) => party.userId),
  )
  const readyNotices = terms.parties.map((party) => {
    const counterpart = terms.parties.find((other) => other.userId !== party.userId)
    return {
      userId: party.userId,
      collabId: input.collabId,
      agreementId,
      collabTitle: input.collabTitle,
      counterpartName: counterpart?.name ?? "your collaborator",
      terms: splits,
      payoutsReady: readiness.get(party.userId) ?? false,
    }
  })
  return { agreementId, readyNotices }
}

/**
 * Send the `agreement.ready` notices once the collab is committed. Each has a dedupe key, so a
 * repeat sends nothing; a failure is reported, never thrown (the acceptance already committed).
 */
export async function sendAgreementReadyNotices(
  database: DbOrTx,
  notices: readonly AgreementReadyNotice[],
): Promise<void> {
  for (const notice of notices) {
    try {
      await notifyAgreementReady(database, notice)
    } catch (error) {
      reportError(error, { tags: { area: "agreements", step: "notify_ready" } })
    }
  }
}

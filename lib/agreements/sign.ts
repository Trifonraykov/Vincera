import "server-only"

import { isIP } from "node:net"

import { and, eq } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { ACTION_MESSAGES } from "@/lib/actions/result"
import { canSignAgreement, type AuthzUser } from "@/lib/auth/authz"
import { now } from "@/lib/clock"
import { touchCollabActivity } from "@/lib/collabs/activity"
import { notifyAgreementSigned } from "@/lib/collabs/notifications"
import { loadCollabTitle, loadPayoutsReadiness } from "@/lib/collabs/queries"
import { changeCollabStage } from "@/lib/collabs/stage"
import { withTransaction, type DbOrTx } from "@/lib/db/client"
import {
  agreementSignatures,
  agreements,
  collabMembers,
  collabs,
  type AgreementTerms,
} from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { enqueue } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"

import { typedNameSchema } from "./fields"
import { agreementIntegrityProblem } from "./integrity"

/**
 * Click-signing (§12 "Agreement page", CLAUDE.md §19.24 "Agreement", §19.28). One transaction per
 * signature, under the agreement's row lock, so two members signing at once, or one member
 * double-clicking, serialize:
 *
 * - a member who already signed gets success again (idempotent, nothing written twice);
 * - the rules: an active member, an agreement awaiting signatures, a collab still in `agreement`
 *   (`canSignAgreement`), the text the signer was shown (`bodyHash`) equal to the stored one, the
 *   stored agreement intact (lib/agreements/integrity.ts), and **both** members payouts-ready;
 * - the signature (typed name, time, IP, user agent, the body hash signed), `agreement.signed`,
 *   the collab's activity, and `agreement.signed` to the member still to sign;
 * - the last signature also sets `signed` + `completed_at`, emits `agreement.completed`, moves the
 *   collab `agreement → building` (`collab.stage_changed`), and after the commit enqueues
 *   `agreements/finalize` (the PDF and the emails with it attached).
 */

export const AGREEMENT_MESSAGES = {
  notFound: "We couldn't find that agreement.",
  stale:
    "The agreement changed since you opened it. Reload the page and read it again before signing.",
  complete: "This agreement is already signed by both of you.",
  terminated: "This agreement was replaced, so it can no longer be signed.",
  collabEnded: "This collab has ended, so its agreement can no longer be signed.",
  integrity:
    "We can't take signatures on this agreement right now because its text doesn't match the agreed terms. We've been alerted and will contact you.",
  payoutsSelf:
    "Set up payouts before you sign, so you get paid for every sale. It takes a few minutes in Settings → Payouts.",
  payoutsOther: (names: string) =>
    `${names} still need${names.includes(" and ") ? "" : "s"} to set up payouts. You can both sign once everyone can be paid. Their agreement email asked them to; you can remind them in Messages.`,
  payoutsBoth: (names: string) =>
    `You and ${names} both need to set up payouts before signing. It takes a few minutes in Settings → Payouts.`,
} as const

export type SignAgreementInput = {
  agreementId: string
  /** What the signer typed; normalised and checked again here. */
  typedName: string
  /** `body_hash` of the text the signer was shown. */
  bodyHash: string
  /** The client's IP (stored only when it is a valid address) and browser. */
  ip: string | null
  userAgent: string | null
}

export type SignAgreementResult = {
  /** `already_signed`: this member had signed before (an idempotent repeat). */
  status: "signed" | "already_signed"
  /** Both members have signed now. */
  completed: boolean
  collabId: string
}

const USER_AGENT_MAX = 500

function cleanIp(ip: string | null): string | null {
  if (!ip) return null
  const trimmed = ip.trim()
  return isIP(trimmed) ? trimmed : null
}

function cleanUserAgent(userAgent: string | null): string | null {
  const trimmed = userAgent?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return trimmed ? trimmed.slice(0, USER_AGENT_MAX) : null
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "Your collaborator"
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

export async function signAgreement(
  database: DbOrTx,
  user: AuthzUser,
  input: SignAgreementInput,
): Promise<SignAgreementResult> {
  const typedName = typedNameSchema.safeParse(input.typedName)
  if (!typedName.success) {
    const message = typedName.error.issues[0]?.message ?? ACTION_MESSAGES.invalidInput
    throw new ActionError(message, { fieldErrors: { typedName: [message] } })
  }

  const result = await withTransaction(async (tx) => {
    const [agreement] = await tx
      .select({
        id: agreements.id,
        collabId: agreements.collabId,
        status: agreements.status,
        templateVersion: agreements.templateVersion,
        terms: agreements.terms,
        renderedBody: agreements.renderedBody,
        bodyHash: agreements.bodyHash,
        createdAt: agreements.createdAt,
        stage: collabs.stage,
      })
      .from(agreements)
      .innerJoin(collabs, eq(collabs.id, agreements.collabId))
      .where(eq(agreements.id, input.agreementId))
      .for("update", { of: agreements })
    if (!agreement) throw new ActionError(AGREEMENT_MESSAGES.notFound)

    const members = await tx
      .select({
        userId: collabMembers.userId,
        role: collabMembers.role,
        splitPct: collabMembers.splitPct,
      })
      .from(collabMembers)
      .where(eq(collabMembers.collabId, agreement.collabId))
    const self = members.find((member) => member.userId === user.id)
    // Not a member (admins included: they read, never sign): a stranger learns nothing.
    if (!self) throw new ActionError(AGREEMENT_MESSAGES.notFound)

    const signatures = await tx
      .select({ userId: agreementSignatures.userId })
      .from(agreementSignatures)
      .where(eq(agreementSignatures.agreementId, agreement.id))
    const signedUserIds = signatures.map((signature) => signature.userId)
    if (signedUserIds.includes(user.id)) {
      return {
        status: "already_signed" as const,
        completed: agreement.status === "signed",
        collabId: agreement.collabId,
      }
    }
    if (agreement.status === "signed") throw new ActionError(AGREEMENT_MESSAGES.complete)
    if (agreement.status === "terminated") throw new ActionError(AGREEMENT_MESSAGES.terminated)
    if (agreement.stage !== "agreement") throw new ActionError(AGREEMENT_MESSAGES.collabEnded)
    const access = {
      memberUserIds: members.map((member) => member.userId),
      status: agreement.status,
      signedUserIds,
    }
    if (!canSignAgreement(user, access)) throw new ActionError(ACTION_MESSAGES.forbidden)

    // The text the signer read must be the text stored (a stale page is not a signature on it).
    if (input.bodyHash !== agreement.bodyHash) throw new ActionError(AGREEMENT_MESSAGES.stale)
    const problem = agreementIntegrityProblem(agreement, members)
    if (problem) {
      reportError(new Error(`Agreement integrity check failed: ${problem}`), {
        tags: { area: "agreements", check: problem },
        extra: { agreementId: agreement.id, collabId: agreement.collabId },
      })
      throw new ActionError(AGREEMENT_MESSAGES.integrity)
    }

    // §12: both members must be payouts-ready (§19.10), checked now, not when the page loaded.
    const readiness = await loadPayoutsReadiness(tx, access.memberUserIds)
    const notReady = members.filter((member) => !readiness.get(member.userId))
    if (notReady.length > 0) {
      const terms: AgreementTerms = agreement.terms
      const otherNames = notReady
        .filter((member) => member.userId !== user.id)
        .map(
          (member) =>
            terms.parties.find((party) => party.userId === member.userId)?.name ??
            "Your collaborator",
        )
      const selfMissing = notReady.some((member) => member.userId === user.id)
      throw new ActionError(
        selfMissing && otherNames.length > 0
          ? AGREEMENT_MESSAGES.payoutsBoth(joinNames(otherNames))
          : selfMissing
            ? AGREEMENT_MESSAGES.payoutsSelf
            : AGREEMENT_MESSAGES.payoutsOther(joinNames(otherNames)),
      )
    }

    const at = now()
    // The unique (agreement, user) key backs the check above; under the row lock it never fires.
    await tx.insert(agreementSignatures).values({
      agreementId: agreement.id,
      userId: user.id,
      signedAt: at,
      ip: cleanIp(input.ip),
      userAgent: cleanUserAgent(input.userAgent),
      typedName: typedName.data,
      bodyHash: agreement.bodyHash,
      createdAt: at,
    })
    const base = {
      actorUserId: user.id,
      subjectType: "agreement" as const,
      subjectId: agreement.id,
      occurredAt: at,
    }
    await track(
      "agreement.signed",
      { ...base, properties: { collab_id: agreement.collabId, role: self.role } },
      tx,
    )
    await touchCollabActivity(tx, agreement.collabId, at)

    const remaining = members.filter(
      (member) => member.userId !== user.id && !signedUserIds.includes(member.userId),
    )
    if (remaining.length === 0) {
      const completed = await tx
        .update(agreements)
        .set({ status: "signed", completedAt: at, updatedAt: at })
        .where(and(eq(agreements.id, agreement.id), eq(agreements.status, "awaiting_signatures")))
        .returning({ id: agreements.id })
      if (completed.length === 0) throw new ActionError(AGREEMENT_MESSAGES.complete)
      await track(
        "agreement.completed",
        {
          ...base,
          properties: {
            collab_id: agreement.collabId,
            template_version: agreement.templateVersion,
          },
        },
        tx,
      )
      await changeCollabStage(tx, {
        collabId: agreement.collabId,
        from: "agreement",
        to: "building",
        actorUserId: user.id,
      })
      return { status: "signed" as const, completed: true, collabId: agreement.collabId }
    }

    const signerName =
      agreement.terms.parties.find((party) => party.userId === user.id)?.name ?? "Your collaborator"
    const collabTitle = await loadCollabTitle(tx, agreement.collabId)
    for (const member of remaining) {
      await notifyAgreementSigned(tx, {
        userId: member.userId,
        collabId: agreement.collabId,
        agreementId: agreement.id,
        collabTitle,
        signerName,
        recipientPayoutsReady: readiness.get(member.userId) ?? false,
      })
    }
    return { status: "signed" as const, completed: false, collabId: agreement.collabId }
  }, database)

  if (result.status === "signed" && result.completed) {
    await requestAgreementFinalize(input.agreementId)
  }
  return result
}

/**
 * Render and email the signed PDF in the background (`agreements-finalize`). An enqueue failure is
 * reported, never thrown: the signatures are committed, and the daily reminders job finalizes
 * signed agreements that still have no PDF.
 */
export async function requestAgreementFinalize(
  agreementId: string,
  options: { attempt?: string } = {},
): Promise<void> {
  try {
    // The event id deduplicates at Inngest for 24 hours: the post-signature request uses a fixed
    // one; the daily safety net passes its own `attempt` (the day), so its re-send is never
    // dropped as a duplicate of an earlier event whose run failed (CLAUDE.md §19.30).
    const id = options.attempt
      ? `finalize:${agreementId}:${options.attempt}`
      : `finalize:${agreementId}`
    await enqueue("agreements/finalize.requested", { agreementId }, { id })
  } catch (error) {
    reportError(error, { tags: { area: "agreements", step: "enqueue_finalize" } })
  }
}

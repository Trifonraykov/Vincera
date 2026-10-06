"use server"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import {
  canAdjustLedger,
  canGrantAdmin,
  canImpersonate,
  canManagePayouts,
  canManageUsers,
  canPauseLaunch,
  canRefundOrder,
  canResolveDispute,
  canReviewDispute,
  canRevokeAdmin,
  canSuspendUser,
} from "@/lib/auth/authz"
import { impersonationCookieOptions } from "@/lib/auth/impersonation"
import { IMPERSONATION_COOKIE, signImpersonationCookie } from "@/lib/auth/impersonation-cookie"
import { getRealUser } from "@/lib/auth/session"
import { getDb, withTransaction } from "@/lib/db/client"
import { disputes } from "@/lib/db/schema"
import { env } from "@/lib/env"
import { loadLaunchAccess } from "@/lib/launches/queries"
import { pauseLaunch } from "@/lib/launches/service"
import { rateLimit } from "@/lib/ratelimit"
import { getStripeGateway } from "@/lib/stripe/gateway"
import { grantAdminRole, revokeAdminRole } from "@/lib/users/roles"

import { DISPUTE_ERRORS, resolveDispute, reviewDispute } from "./disputes"
import {
  adjustmentFormSchema,
  adminNote,
  DISPUTE_OUTCOMES,
  IMPERSONATION_REASON_MAX,
  parseSignedCents,
  RESOLUTION_NOTE_MAX,
} from "./fields"
import { startImpersonationSession, stopImpersonationSessions } from "./impersonation"
import { createLedgerAdjustment, type AdjustmentLine } from "./ledger-adjustments"
import { cancelStuckRefund, retryStuckRefund, startPayoutRun } from "./payouts"
import { loadAdminTarget, suspendUser, unsuspendUser, USER_ERRORS } from "./users"

/**
 * Admin server actions (Phase 6; CLAUDE.md §19.38–§19.39). Each is `defineAction` with an admin
 * rule from lib/auth/authz.ts (checked again under the row lock by the service), one transaction
 * with the change and its `admin_audit_log` row, and its event where the catalog has one.
 * `stopImpersonation` is the documented exception (a plain server action): it must work while
 * the admin views the app as someone else, when every `defineAction` refuses.
 */

const userId = z.uuid({ error: "That account link is not valid." })
const disputeId = z.uuid({ error: "That dispute link is not valid." })

function revalidateAdmin(): void {
  revalidatePath("/admin", "layout")
}

async function target(id: string) {
  const row = await loadAdminTarget(getDb(), id)
  if (!row) throw new ActionError(USER_ERRORS.notFound)
  return row
}

// --- Users --------------------------------------------------------------------------------------

export const suspendUserAction = defineAction({
  name: "admin.suspend_user",
  input: z.object({ userId }),
  authorize: async (user, input) => canSuspendUser(user, await target(input.userId)),
  run: async ({ input, user, db }) => {
    const result = await suspendUser(db, user, input)
    revalidateAdmin()
    return result
  },
})

export const unsuspendUserAction = defineAction({
  name: "admin.unsuspend_user",
  input: z.object({ userId }),
  authorize: async (user, input) => canSuspendUser(user, await target(input.userId)),
  run: async ({ input, user, db }) => {
    await unsuspendUser(db, user, input)
    revalidateAdmin()
    return { status: "active" as const }
  },
})

export const grantAdminAction = defineAction({
  name: "admin.grant_admin",
  input: z.object({ userId }),
  authorize: async (user, input) => canGrantAdmin(user, await target(input.userId)),
  run: async ({ input, user, db }) => {
    const granted = await grantAdminRole(db, {
      userId: input.userId,
      source: "admin",
      grantedByUserId: user.id,
    })
    revalidateAdmin()
    return { granted }
  },
})

export const revokeAdminAction = defineAction({
  name: "admin.revoke_admin",
  input: z.object({ userId }),
  authorize: async (user, input) => canRevokeAdmin(user, await target(input.userId)),
  run: async ({ input, user, db }) => {
    const revoked = await revokeAdminRole(db, { userId: input.userId, revokedByUserId: user.id })
    revalidateAdmin()
    return { revoked }
  },
})

// --- Read-only "view as" ------------------------------------------------------------------------

/** 20 starts per admin per hour (CLAUDE.md §19.38 `impersonation-start`). */
const IMPERSONATION_RATE_LIMIT = { limit: 20, window: "1 h" } as const

export const startImpersonationAction = defineAction({
  name: "admin.start_impersonation",
  input: z.object({
    userId,
    reason: adminNote(IMPERSONATION_REASON_MAX, "Say why you need to look, for the audit log."),
  }),
  authorize: async (user, input) => canImpersonate(user, await target(input.userId)),
  run: async ({ input, user, db }) => {
    const limit = await rateLimit("impersonation-start", user.id, IMPERSONATION_RATE_LIMIT)
    if (!limit.success) {
      throw new ActionError("You've started many views this hour. Try again a little later.")
    }
    const session = await startImpersonationSession(db, user, {
      targetUserId: input.userId,
      reason: input.reason,
    })
    ;(await cookies()).set(
      IMPERSONATION_COOKIE,
      signImpersonationCookie(
        {
          sessionId: session.sessionId,
          adminUserId: user.id,
          targetUserId: session.targetUserId,
          expiresAt: session.expiresAt,
        },
        env.AUTH_SECRET,
      ),
      impersonationCookieOptions(session.expiresAt),
    )
    revalidatePath("/", "layout")
    redirect("/app")
  },
})

/**
 * "Stop viewing" (the banner in both shells). A plain server action, because it must work while
 * every `defineAction` refuses: it checks the **real** signed-in user (`canManageUsers`), ends the
 * admin's open session (audited) and deletes the cookie.
 */
export async function stopImpersonation(): Promise<void> {
  const user = await getRealUser()
  if (!user) redirect("/sign-in")
  if (!canManageUsers(user)) redirect("/app")
  const { targetUserId } = await stopImpersonationSessions(getDb(), user.id)
  ;(await cookies()).delete(IMPERSONATION_COOKIE)
  revalidatePath("/", "layout")
  redirect(targetUserId ? `/admin/users/${targetUserId}` : "/admin/users")
}

// --- Disputes -----------------------------------------------------------------------------------

async function disputeStatus(id: string) {
  const [row] = await getDb()
    .select({ status: disputes.status })
    .from(disputes)
    .where(eq(disputes.id, id))
  if (!row) throw new ActionError(DISPUTE_ERRORS.notFound)
  return row
}

export const reviewDisputeAction = defineAction({
  name: "admin.review_dispute",
  input: z.object({ disputeId }),
  authorize: async (user, input) => {
    const dispute = await disputeStatus(input.disputeId)
    if (dispute.status !== "open") throw new ActionError(DISPUTE_ERRORS.notOpen)
    return canReviewDispute(user, dispute)
  },
  run: async ({ input, user, db }) => {
    await reviewDispute(db, user, input)
    revalidateAdmin()
    return { status: "in_review" as const }
  },
})

/** Typed lines → cents; field errors name the line. */
function parseLines(
  lines: { party: string; amount: string }[],
): { ok: true; lines: AdjustmentLine[] } | { ok: false; error: string } {
  const parsed: AdjustmentLine[] = []
  for (const [index, line] of lines.entries()) {
    const cents = parseSignedCents(line.amount)
    if (cents === null || cents === 0) {
      return {
        ok: false,
        error: `Line ${index + 1}: enter an amount in euros, like -5 or 12.50 (not zero).`,
      }
    }
    parsed.push({ userId: line.party === "platform" ? null : line.party, amountCents: cents })
  }
  return { ok: true, lines: parsed }
}

const resolveInput = z
  .object({
    disputeId,
    outcome: z.enum(DISPUTE_OUTCOMES, { error: "Pick an outcome." }),
    note: adminNote(RESOLUTION_NOTE_MAX, "Write a short note: the members read it."),
    adjustment: adjustmentFormSchema.omit({ disputeId: true }).optional(),
  })
  .refine((value) => value.outcome !== "adjusted" || value.adjustment !== undefined, {
    message: DISPUTE_ERRORS.needsLines,
    path: ["adjustment"],
  })

export const resolveDisputeAction = defineAction({
  name: "admin.resolve_dispute",
  input: resolveInput,
  authorize: async (user, input) => {
    const dispute = await disputeStatus(input.disputeId)
    if (dispute.status === "open") throw new ActionError(DISPUTE_ERRORS.notInReview)
    if (dispute.status === "resolved") throw new ActionError("This dispute is already resolved.")
    return canResolveDispute(user, dispute)
  },
  run: async ({ input, user, db }) => {
    let adjustment
    if (input.outcome === "adjusted" && input.adjustment) {
      const lines = parseLines(input.adjustment.lines)
      if (!lines.ok) throw new ActionError(lines.error)
      adjustment = {
        orderId: input.adjustment.orderId ?? null,
        reason: input.adjustment.reason,
        lines: lines.lines,
      }
    }
    const result = await resolveDispute(db, user, {
      disputeId: input.disputeId,
      outcome: input.outcome,
      note: input.note,
      adjustment,
    })
    revalidateAdmin()
    revalidatePath("/app", "layout")
    return result
  },
})

/** A ledger adjustment outside a dispute's resolution (payouts page, or an extra one later). */
export const createLedgerAdjustmentAction = defineAction({
  name: "admin.ledger_adjustment",
  input: adjustmentFormSchema,
  authorize: (user) => canAdjustLedger(user),
  run: async ({ input, user, db }) => {
    const lines = parseLines(input.lines)
    if (!lines.ok) throw new ActionError(lines.error)
    const result = await withTransaction(
      (tx) =>
        createLedgerAdjustment(tx, {
          adminUserId: user.id,
          disputeId: input.disputeId ?? null,
          orderId: input.orderId ?? null,
          reason: input.reason,
          currency: "eur",
          lines: lines.lines,
        }),
      db,
    )
    revalidateAdmin()
    return { adjustmentId: result.adjustmentId }
  },
})

// --- Launches (a dispute's pause) ---------------------------------------------------------------

export const pauseLaunchForDisputeAction = defineAction({
  name: "admin.pause_launch_dispute",
  input: z.object({ launchId: z.uuid({ error: "That launch link is not valid." }) }),
  authorize: async (user, input) => {
    const access = await loadLaunchAccess(getDb(), input.launchId)
    if (!access) throw new ActionError("That launch doesn't exist.")
    return canPauseLaunch(user, access)
  },
  run: async ({ input, user, db }) => {
    const result = await pauseLaunch(db, user, { launchId: input.launchId, dueToDispute: true })
    revalidateAdmin()
    return result
  },
})

// --- Payouts and refunds ------------------------------------------------------------------------

export const startPayoutRunAction = defineAction({
  name: "admin.start_payout_run",
  input: z.object({}),
  authorize: (user) => canManagePayouts(user),
  run: async ({ user, db }) => {
    const result = await startPayoutRun(db, user)
    revalidateAdmin()
    return result
  },
})

const refundId = z.uuid({ error: "That refund link is not valid." })

export const retryStuckRefundAction = defineAction({
  name: "admin.retry_refund",
  input: z.object({ refundId }),
  authorize: (user) => canRefundOrder(user),
  run: async ({ input, user, db }) => {
    const result = await retryStuckRefund(db, user, input, { gateway: getStripeGateway() })
    revalidateAdmin()
    return result
  },
})

export const cancelStuckRefundAction = defineAction({
  name: "admin.cancel_refund",
  input: z.object({ refundId }),
  authorize: (user) => canRefundOrder(user),
  run: async ({ input, user, db }) => {
    await cancelStuckRefund(db, user, input)
    revalidateAdmin()
    return { status: "canceled" as const }
  },
})

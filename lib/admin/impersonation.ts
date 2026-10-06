import "server-only"

import { and, eq, isNull } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import { canImpersonate, type AuthzUser } from "@/lib/auth/authz"
import { IMPERSONATION_TTL_MINUTES } from "@/lib/auth/impersonation-cookie"
import { now } from "@/lib/clock"
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client"
import { impersonationSessions, users } from "@/lib/db/schema"

import { writeAdminAudit } from "./audit"

/**
 * Starting and stopping read-only "view as" (§6; CLAUDE.md §19.38). The per-request reading of
 * the cookie lives in lib/auth/impersonation.ts; the actions that set and delete the cookie in
 * lib/admin/actions.ts. Start and stop are audited (`impersonation.started` / `.stopped`); there
 * is no event (the catalog has none).
 */

export const IMPERSONATION_ERRORS = {
  notFound: "That account doesn't exist.",
  notAllowed:
    "You can only view the app as an active account that isn't an admin, and not as yourself.",
} as const

type EndReason = "stopped" | "replaced" | "expired"

/** End the admin's open session(s): `expired` when past their end, else `reason`; audited. */
async function endOpenSessions(
  tx: Tx,
  adminUserId: string,
  reason: Exclude<EndReason, "expired">,
  at: Date,
): Promise<{ targetUserId: string; sessionId: string }[]> {
  const open = await tx
    .select()
    .from(impersonationSessions)
    .where(
      and(
        eq(impersonationSessions.adminUserId, adminUserId),
        isNull(impersonationSessions.endedAt),
      ),
    )
    .for("update")
  const ended: { targetUserId: string; sessionId: string }[] = []
  for (const session of open) {
    const endReason: EndReason = session.expiresAt <= at ? "expired" : reason
    // An expired session ends at its expiry (it was over then); `ended_at` ≥ `started_at` holds.
    const endedAt = endReason === "expired" ? session.expiresAt : at
    await tx
      .update(impersonationSessions)
      .set({ endedAt, endReason })
      .where(eq(impersonationSessions.id, session.id))
    await writeAdminAudit(tx, {
      adminUserId,
      action: "impersonation.stopped",
      targetType: "impersonation_session",
      targetId: session.id,
      before: { target_user_id: session.targetUserId, ended: false },
      after: { target_user_id: session.targetUserId, ended: true, end_reason: endReason },
    })
    ended.push({ targetUserId: session.targetUserId, sessionId: session.id })
  }
  return ended
}

/**
 * Open a "view as" session (one transaction): end the admin's open one (`replaced`, or `expired`
 * when it already ran out), check `canImpersonate` under the target's row lock, insert the
 * session (60 minutes) and audit `impersonation.started` with the target and the reason.
 */
export async function startImpersonationSession(
  db: DbOrTx,
  admin: AuthzUser,
  input: { targetUserId: string; reason: string },
): Promise<{ sessionId: string; targetUserId: string; expiresAt: Date }> {
  return withTransaction(async (tx) => {
    const at = now()
    const [target] = await tx
      .select({
        id: users.id,
        roles: users.roles,
        status: users.status,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, input.targetUserId))
      .for("share")
    if (!target) throw new ActionError(IMPERSONATION_ERRORS.notFound)
    if (!canImpersonate(admin, target)) throw new ActionError(IMPERSONATION_ERRORS.notAllowed)

    await endOpenSessions(tx, admin.id, "replaced", at)
    const expiresAt = new Date(at.getTime() + IMPERSONATION_TTL_MINUTES * 60 * 1000)
    const [session] = await tx
      .insert(impersonationSessions)
      .values({
        adminUserId: admin.id,
        targetUserId: target.id,
        reason: input.reason,
        startedAt: at,
        expiresAt,
      })
      .returning({ id: impersonationSessions.id })
    if (!session) throw new Error("impersonation session not inserted")
    await writeAdminAudit(tx, {
      adminUserId: admin.id,
      action: "impersonation.started",
      targetType: "impersonation_session",
      targetId: session.id,
      before: null,
      after: {
        target_user_id: target.id,
        reason: input.reason,
        expires_at: expiresAt.toISOString(),
      },
    })
    return { sessionId: session.id, targetUserId: target.id, expiresAt }
  }, db)
}

/** "Stop viewing": end the admin's open session(s), audited. Returns whom they viewed last. */
export async function stopImpersonationSessions(
  db: DbOrTx,
  adminUserId: string,
): Promise<{ targetUserId: string | null }> {
  return withTransaction(async (tx) => {
    const ended = await endOpenSessions(tx, adminUserId, "stopped", now())
    return { targetUserId: ended.at(-1)?.targetUserId ?? null }
  }, db)
}

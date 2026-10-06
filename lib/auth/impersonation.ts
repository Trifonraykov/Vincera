import "server-only"

import { and, eq, gt, isNull } from "drizzle-orm"
import { cookies } from "next/headers"

import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import { impersonationSessions, users } from "@/lib/db/schema"
import { env } from "@/lib/env"

import { canImpersonate } from "./authz"
import {
  IMPERSONATION_COOKIE,
  verifyImpersonationCookie,
  type ImpersonationClaim,
} from "./impersonation-cookie"
import { parseAuthUser, type AuthUser } from "./user"

/**
 * Read-only "view as" (§6; CLAUDE.md §19.38), the shared core. The admin area (lib/admin) starts
 * and stops sessions and shows the banner; this module decides, per request:
 *
 * - **Reads:** `getViewer()` (lib/auth/session.ts) returns the target as `user` when the
 *   signed-in user is an admin, the signed cookie names them and the session row is open
 *   (`loadActiveImpersonation`). Pages then render exactly what the target sees.
 * - **Writes:** every mutation path refuses while the cookie names the acting user as its target
 *   (`isMutationBlockedByImpersonation`): `defineAction` (all server actions), the social OAuth
 *   routes and the payouts refresh routes. That check needs no database, so it holds even when a
 *   test or a caller swaps the session helpers.
 */

export { IMPERSONATION_COOKIE, type ImpersonationClaim } from "./impersonation-cookie"

/** What every refused mutation answers while viewing as someone else. */
export const IMPERSONATION_READ_ONLY_MESSAGE =
  "You're viewing the app as someone else, so changes are turned off. Stop viewing to make changes."

/** The open session behind a valid "view as". */
export type ActiveImpersonation = {
  sessionId: string
  adminUserId: string
  target: AuthUser
  expiresAt: Date
}

/** Cookie options for `cookies().set(IMPERSONATION_COOKIE, value, options)`. */
export function impersonationCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: new URL(env.NEXT_PUBLIC_APP_URL).protocol === "https:",
    path: "/",
    expires: expiresAt,
  }
}

/** Verify a raw cookie value (the proxy passes `request.cookies.get(...)?.value`). */
export function impersonationClaimFrom(
  value: string | null | undefined,
): ImpersonationClaim | null {
  if (!value) return null
  return verifyImpersonationCookie(value, env.AUTH_SECRET, now())
}

/**
 * The verified claim of this request's cookie, or null. Outside a request (scripts, tests that
 * call actions directly) there are no cookies, which reads as "not impersonating".
 */
export async function readImpersonationClaim(): Promise<ImpersonationClaim | null> {
  let value: string | undefined
  try {
    value = (await cookies()).get(IMPERSONATION_COOKIE)?.value
  } catch {
    return null
  }
  return impersonationClaimFrom(value)
}

/**
 * The target user for a valid "view as": `realUser` is the signed-in admin of the claim, the
 * session row is open and unexpired, and the target may still be viewed (`canImpersonate`: an
 * active, not deleted, non-admin account). Null otherwise; the caller then shows the real user.
 */
export async function loadActiveImpersonation(
  db: DbOrTx,
  input: { realUser: AuthUser; claim: ImpersonationClaim; at?: Date },
): Promise<ActiveImpersonation | null> {
  const { realUser, claim } = input
  const at = input.at ?? now()
  if (claim.adminUserId !== realUser.id) return null
  const [session] = await db
    .select({ id: impersonationSessions.id, expiresAt: impersonationSessions.expiresAt })
    .from(impersonationSessions)
    .where(
      and(
        eq(impersonationSessions.id, claim.sessionId),
        eq(impersonationSessions.adminUserId, realUser.id),
        eq(impersonationSessions.targetUserId, claim.targetUserId),
        isNull(impersonationSessions.endedAt),
        gt(impersonationSessions.expiresAt, at),
      ),
    )
    .limit(1)
  if (!session) return null
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      roles: users.roles,
      activeRole: users.activeRole,
      status: users.status,
      onboardingCompletedAt: users.onboardingCompletedAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, claim.targetUserId))
    .limit(1)
  if (!row || !canImpersonate(realUser, row)) return null
  const target = parseAuthUser(row)
  if (!target) return null
  return {
    sessionId: session.id,
    adminUserId: realUser.id,
    target,
    expiresAt: session.expiresAt,
  }
}

/**
 * True when this request carries a valid "view as" cookie whose target is `actingUser`: the
 * mutation must be refused. Every server action (`defineAction`) and every signed-in route handler
 * that changes something calls it.
 */
export async function isMutationBlockedByImpersonation(
  actingUser: Pick<AuthUser, "id">,
): Promise<boolean> {
  const claim = await readImpersonationClaim()
  return claim !== null && claim.targetUserId === actingUser.id
}

/** For route handlers: a 403 answer while viewing as someone else, else null. */
export async function impersonationRefusalResponse(
  actingUser: Pick<AuthUser, "id"> | null,
): Promise<Response | null> {
  if (!actingUser || !(await isMutationBlockedByImpersonation(actingUser))) return null
  return new Response(IMPERSONATION_READ_ONLY_MESSAGE, {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  })
}

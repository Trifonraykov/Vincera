import "server-only"

import { createHash, randomBytes } from "node:crypto"

import { and, eq, gt } from "drizzle-orm"

import { parseAuthUser, type AuthUser } from "@/lib/auth/user"
import { now } from "@/lib/clock"
import type { DbOrTx } from "@/lib/db/client"
import { mobileSessions, users } from "@/lib/db/schema"

/**
 * Bearer sessions of the native app (CLAUDE.md §19.44). The token is 32 random bytes (base64url)
 * behind a recognisable prefix; only its sha256 is stored. Lifetime 30 days like web sessions,
 * sliding: a session used with less than 15 days left is extended to 30 again (at most once an hour,
 * so a busy app does not write on every request).
 */

export const MOBILE_TOKEN_PREFIX = "vmb_"
export const MOBILE_SESSION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const REFRESH_BELOW_MS = 15 * DAY_MS
const TOKEN_PATTERN = /^vmb_[A-Za-z0-9_-]{43}$/

export function hashMobileToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** The token from `Authorization: Bearer <token>`, or null when missing or not ours. */
export function bearerToken(headers: Headers): string | null {
  const value = headers.get("authorization")?.trim()
  const match = value?.match(/^Bearer\s+(\S+)$/i)
  const token = match?.[1] ?? null
  return token && TOKEN_PATTERN.test(token) ? token : null
}

export async function createMobileSession(
  database: DbOrTx,
  input: { userId: string; deviceName?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = `${MOBILE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
  const at = now()
  const expiresAt = new Date(at.getTime() + MOBILE_SESSION_DAYS * DAY_MS)
  const deviceName =
    input.deviceName
      ?.replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim()
      .slice(0, 100) || null
  await database.insert(mobileSessions).values({
    userId: input.userId,
    tokenHash: hashMobileToken(token),
    deviceName,
    lastUsedAt: at,
    expiresAt,
  })
  return { token, expiresAt }
}

/**
 * The user behind a bearer token, read fresh from `users` on every request (roles, active role,
 * status), like the web's database sessions. Null for unknown or expired tokens and for users
 * without an email (anonymised accounts).
 */
export async function findMobileSessionUser(
  database: DbOrTx,
  token: string,
): Promise<{ user: AuthUser; sessionId: string } | null> {
  const at = now()
  const [row] = await database
    .select({
      sessionId: mobileSessions.id,
      expiresAt: mobileSessions.expiresAt,
      lastUsedAt: mobileSessions.lastUsedAt,
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      roles: users.roles,
      activeRole: users.activeRole,
      status: users.status,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(mobileSessions)
    .innerJoin(users, eq(users.id, mobileSessions.userId))
    .where(
      and(eq(mobileSessions.tokenHash, hashMobileToken(token)), gt(mobileSessions.expiresAt, at)),
    )
    .limit(1)
  if (!row) return null
  const user = parseAuthUser(row)
  if (!user) return null

  const remaining = row.expiresAt.getTime() - at.getTime()
  if (remaining < REFRESH_BELOW_MS && at.getTime() - row.lastUsedAt.getTime() >= DAY_MS / 24) {
    await database
      .update(mobileSessions)
      .set({ lastUsedAt: at, expiresAt: new Date(at.getTime() + MOBILE_SESSION_DAYS * DAY_MS) })
      .where(eq(mobileSessions.id, row.sessionId))
  }
  return { user, sessionId: row.sessionId }
}

/** Sign out this device: the token stops working at once. */
export async function deleteMobileSession(database: DbOrTx, token: string): Promise<boolean> {
  const deleted = await database
    .delete(mobileSessions)
    .where(eq(mobileSessions.tokenHash, hashMobileToken(token)))
    .returning({ id: mobileSessions.id })
  return deleted.length > 0
}

/** "Sign out everywhere" also signs out every phone (lib/users/account.ts). */
export async function deleteAllMobileSessions(database: DbOrTx, userId: string): Promise<number> {
  const deleted = await database
    .delete(mobileSessions)
    .where(eq(mobileSessions.userId, userId))
    .returning({ id: mobileSessions.id })
  return deleted.length
}

export async function countMobileSessions(database: DbOrTx, userId: string): Promise<number> {
  const rows = await database
    .select({ id: mobileSessions.id })
    .from(mobileSessions)
    .where(and(eq(mobileSessions.userId, userId), gt(mobileSessions.expiresAt, now())))
  return rows.length
}

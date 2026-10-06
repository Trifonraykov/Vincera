import { createHmac, timingSafeEqual } from "node:crypto"

import { z } from "zod"

/**
 * The signed cookie behind read-only "view as" (§6; CLAUDE.md §19.38). Pure: the secret and the
 * clock are parameters, so the proxy, the session helpers and tests share it.
 *
 * Value: `v1.<sessionId>.<adminUserId>.<targetUserId>.<expiresAtMs>.<signature>`, where the
 * signature is HMAC-SHA256 (key derived from AUTH_SECRET) over everything before it. The cookie
 * alone never grants anything: `loadActiveImpersonation` (lib/auth/impersonation.ts) also needs
 * the signed-in user to be that admin and the `impersonation_sessions` row to be open. Its only
 * effect on its own is to refuse mutations by the target user in this browser.
 */

export const IMPERSONATION_COOKIE = "admin_view_as"

/** How long one "view as" lasts before it must be started again. */
export const IMPERSONATION_TTL_MINUTES = 60

export type ImpersonationClaim = {
  sessionId: string
  adminUserId: string
  targetUserId: string
  expiresAt: Date
}

const uuid = z.uuid()

function deriveKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("vincera/impersonation/v1").digest()
}

function payload(claim: ImpersonationClaim): string {
  return [
    "v1",
    claim.sessionId,
    claim.adminUserId,
    claim.targetUserId,
    String(claim.expiresAt.getTime()),
  ].join(".")
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", deriveKey(secret)).update(data).digest("base64url")
}

export function signImpersonationCookie(claim: ImpersonationClaim, secret: string): string {
  const data = payload(claim)
  return `${data}.${sign(data, secret)}`
}

/** The claim in a cookie value, or null when it is malformed, tampered with or expired. */
export function verifyImpersonationCookie(
  value: string | null | undefined,
  secret: string,
  now: Date,
): ImpersonationClaim | null {
  if (!value || value.length > 400) return null
  const parts = value.split(".")
  if (parts.length !== 6 || parts[0] !== "v1") return null
  const [, sessionId, adminUserId, targetUserId, expiresMs, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if (![sessionId, adminUserId, targetUserId].every((id) => uuid.safeParse(id).success)) {
    return null
  }
  if (!/^\d{1,15}$/.test(expiresMs)) return null
  const expected = Buffer.from(sign(parts.slice(0, 5).join("."), secret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  const expiresAt = new Date(Number(expiresMs))
  if (expiresAt.getTime() <= now.getTime()) return null
  return { sessionId, adminUserId, targetUserId, expiresAt }
}

import "server-only"

import { createHash } from "node:crypto"

import { NextRequest } from "next/server"
import { z } from "zod"

import { createAuthAdapter } from "@/lib/auth/adapter"
import { EMAIL_PROVIDER_ID } from "@/lib/auth/config"
import { EMAIL_CALLBACK_RATE_LIMIT } from "@/lib/auth/email-callback"
import { normalizeEmail } from "@/lib/auth/email"
import { parsePendingName } from "@/lib/auth/pending-name"
import { SIGN_IN_ERROR_MESSAGES } from "@/lib/auth/routes"
import { normalizeSignInCode } from "@/lib/auth/sign-in-code"
import { isSuspendedSignIn } from "@/lib/auth/suspension"
import { parseAuthUser, type AuthUser } from "@/lib/auth/user"
import { now } from "@/lib/clock"
import type { Db } from "@/lib/db/client"
import type { Env } from "@/lib/env"
import { clientIp, rateLimit, retryAfterSeconds } from "@/lib/ratelimit"

import { MOBILE_MESSAGES, MobileApiError } from "./errors"
import { createMobileSession } from "./sessions"

/**
 * Signing in from the native app (CLAUDE.md §19.44), on top of the web's email sign-in codes
 * (§19.19):
 *
 * - `requestSignInCode` runs Auth.js's own email sign-in in-process, exactly like the web's
 *   `requestMagicLink` server action: the same signIn callback (the §14 `auth` rate limit per IP and
 *   per email, the suspension check), the same 8-character code and the same email (link + code).
 * - `verifySignInCode` checks a typed code the way Auth.js's email callback does (the token is
 *   stored as sha256(code + secret) and used once), under the same `email-callback` rate limit as
 *   `/api/auth/callback/email`, then signs the person up or in through our Auth.js adapter (so a
 *   new account gets `user.signed_up` and the ADMIN_EMAILS grant like any sign-up) and opens a
 *   bearer session instead of setting a cookie.
 */

export type AuthHandlers = {
  GET: (request: NextRequest) => Promise<Response>
  POST: (request: NextRequest) => Promise<Response>
}

export type MobileAuthDeps = { db: Db; env: Env; handlers: AuthHandlers }

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address, like name@example.com.").max(254))

function parseEmail(value: string): string {
  const parsed = emailSchema.safeParse(value)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? MOBILE_MESSAGES.invalidInput
    throw new MobileApiError(400, "invalid_input", message, { email: [message] })
  }
  return normalizeEmail(parsed.data)
}

/** The client's address headers, so Auth.js's rate limit counts the phone, not the server. */
function forwardedHeaders(request: Request): Headers {
  const headers = new Headers()
  for (const name of ["x-forwarded-for", "x-real-ip", "user-agent"]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

function cookiePairs(response: Response): string[] {
  return response.headers.getSetCookie().map((header) => header.split(";")[0] ?? "")
}

/** Send the sign-in email (link and code). Same answer whether or not the account exists. */
export async function requestSignInCode(
  request: Request,
  input: { email: string },
  deps: MobileAuthDeps,
): Promise<void> {
  const email = parseEmail(input.email)
  const base = new URL("/api/auth/", deps.env.NEXT_PUBLIC_APP_URL)
  const headers = forwardedHeaders(request)

  // Auth.js's sign-in endpoint wants its CSRF token (double-submit cookie), like a browser form.
  const csrfResponse = await deps.handlers.GET(
    new NextRequest(new URL("csrf", base), { method: "GET", headers }),
  )
  const csrf = z.object({ csrfToken: z.string() }).safeParse(await csrfResponse.json())
  if (!csrf.success) throw new Error("Auth.js did not return a CSRF token")

  const signInHeaders = new Headers(headers)
  signInHeaders.set("content-type", "application/x-www-form-urlencoded")
  signInHeaders.set("cookie", cookiePairs(csrfResponse).join("; "))
  const response = await deps.handlers.POST(
    new NextRequest(new URL(`signin/${EMAIL_PROVIDER_ID}`, base), {
      method: "POST",
      headers: signInHeaders,
      body: new URLSearchParams({
        email,
        csrfToken: csrf.data.csrfToken,
        callbackUrl: "/app",
      }).toString(),
    }),
  )

  const location = response.headers.get("location") ?? ""
  const error = location ? new URL(location, base).searchParams.get("error") : "Default"
  if (!error) return
  switch (error) {
    case "RateLimited":
      throw new MobileApiError(429, "rate_limited", SIGN_IN_ERROR_MESSAGES.RateLimited)
    case "AccessDenied":
      throw new MobileApiError(403, "suspended", SIGN_IN_ERROR_MESSAGES.AccessDenied)
    case "Configuration":
    case "EmailSignInError":
      throw new MobileApiError(503, "unavailable", MOBILE_MESSAGES.emailFailed)
    default:
      throw new MobileApiError(400, "refused", SIGN_IN_ERROR_MESSAGES.Default)
  }
}

/** Auth.js stores email tokens as sha256(token + secret), hex (@auth/core `createHash`). */
export function hashVerificationToken(token: string, secret: string): string {
  return createHash("sha256").update(`${token}${secret}`).digest("hex")
}

export type VerifiedSession = { token: string; expiresAt: Date; user: AuthUser }

/** Check a typed code; on success, the person is signed up or in and gets a bearer token. */
export async function verifySignInCode(
  request: Request,
  input: { email: string; code: string; deviceName?: string; name?: string },
  deps: MobileAuthDeps,
): Promise<VerifiedSession> {
  const email = parseEmail(input.email)

  // Every attempt counts, per client IP and per email, like the web's code field.
  const keys = [`ip:${clientIp(request.headers)}`, `email:${email}`]
  const limits = await Promise.all(
    keys.map((key) => rateLimit("email-callback", key, EMAIL_CALLBACK_RATE_LIMIT)),
  )
  const blocked = limits.find((result) => !result.success)
  if (blocked) {
    throw new MobileApiError(
      429,
      "rate_limited",
      SIGN_IN_ERROR_MESSAGES.RateLimited,
      undefined,
      retryAfterSeconds(blocked),
    )
  }

  const code = normalizeSignInCode(input.code)
  const badCode = () =>
    new MobileApiError(400, "invalid_input", MOBILE_MESSAGES.badCode, {
      code: [MOBILE_MESSAGES.badCode],
    })
  if (!code) throw badCode()

  const adapter = createAuthAdapter(deps.db, {
    method: "email",
    adminEmails: deps.env.ADMIN_EMAILS,
    pendingName: parsePendingName(input.name),
  })
  if (!adapter.useVerificationToken || !adapter.getUserByEmail || !adapter.createUser) {
    throw new Error("Auth adapter is missing email methods")
  }
  const verification = await adapter.useVerificationToken({
    identifier: email,
    token: hashVerificationToken(code, deps.env.AUTH_SECRET),
  })
  const at = now()
  if (!verification || verification.expires.getTime() < at.getTime()) throw badCode()

  // As Auth.js's email callback: an existing account is marked verified, a new one is created.
  const existing = await adapter.getUserByEmail(email)
  const account = existing
    ? ((await adapter.updateUser?.({ id: existing.id, emailVerified: at })) ?? existing)
    : await adapter.createUser({
        id: crypto.randomUUID(),
        email,
        emailVerified: at,
        name: null,
        image: null,
      })
  if (await isSuspendedSignIn(deps.db, { id: account.id, email })) {
    throw new MobileApiError(403, "suspended", MOBILE_MESSAGES.suspended)
  }

  const session = await createMobileSession(deps.db, {
    userId: account.id,
    deviceName: input.deviceName,
  })
  const user = await loadAuthUser(deps.db, account.id)
  if (!user) throw new Error("Signed-in user failed validation")
  return { ...session, user }
}

async function loadAuthUser(db: Db, userId: string): Promise<AuthUser | null> {
  const row = await db.query.users.findFirst({ where: (users, { eq }) => eq(users.id, userId) })
  return row ? parseAuthUser(row) : null
}

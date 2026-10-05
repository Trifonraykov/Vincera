import "server-only"

import { NextRequest } from "next/server"

import { clientIp, rateLimit, type RateLimitRule } from "@/lib/ratelimit"
import { absoluteUrl } from "@/lib/urls"

import { normalizeEmail } from "./email"
import { signInUrl } from "./routes"
import { normalizeSignInCode } from "./sign-in-code"

/**
 * The magic-link callback (`GET /api/auth/callback/email`), before Auth.js checks the token. The
 * token is also a code people type (lib/auth/sign-in-code.ts), so:
 * - every attempt, a click or a typed code, counts against a limit per client IP and per email
 *   (a wrong guess consumes nothing in Auth.js, so without it codes could be guessed);
 * - a typed code is normalised (case, dashes, spaces, look-alikes) and the email lowercased like
 *   Auth.js stores it, so "abcd-efgh" matches.
 */

export const EMAIL_CALLBACK_PATH = "/api/auth/callback/email"

/** Sign-in attempts through the email callback: 10 per 10 minutes per IP and per email. */
export const EMAIL_CALLBACK_RATE_LIMIT: RateLimitRule = { limit: 10, window: "10 m" }

/** The request to hand to Auth.js, or the response to send instead (rate limited). */
export async function prepareEmailCallback(request: NextRequest): Promise<NextRequest | Response> {
  if (request.nextUrl.pathname !== EMAIL_CALLBACK_PATH) return request

  const url = new URL(request.url)
  const email = url.searchParams.get("email")
  const keys = [`ip:${clientIp(request.headers)}`]
  if (email) keys.push(`email:${normalizeEmail(email)}`)
  const results = await Promise.all(
    keys.map((key) => rateLimit("email-callback", key, EMAIL_CALLBACK_RATE_LIMIT)),
  )
  if (results.some((result) => !result.success)) {
    return Response.redirect(absoluteUrl(signInUrl({ error: "RateLimited" })), 303)
  }

  const token = url.searchParams.get("token")
  const code = normalizeSignInCode(token)
  if (code) url.searchParams.set("token", code)
  if (email) url.searchParams.set("email", normalizeEmail(email))
  if (url.toString() === request.url) return request
  return new NextRequest(url, { headers: request.headers, method: request.method })
}

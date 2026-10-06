import { z } from "zod"

/**
 * The optional name typed on /sign-up. The `users` row is only created when the magic link is
 * opened, so the name waits in a short-lived, httpOnly cookie scoped to `/api/auth`; the adapter's
 * `createUser` reads it from the callback request. It only ever names the account created in the
 * same browser, and is cleared once a sign-in completes.
 */

export const PENDING_NAME_COOKIE = "pending_signup_name"
export const PENDING_NAME_COOKIE_PATH = "/api/auth"
/** Same lifetime as a magic link. */
export const PENDING_NAME_MAX_AGE_SECONDS = 24 * 60 * 60

/** A person's display name: trimmed, 1–80 characters, no control characters. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter your name.")
  .max(80, "Use 80 characters or fewer.")
  .regex(/^[^\u0000-\u001f\u007f]*$/, "Use letters, numbers and punctuation only.")

export function parsePendingName(value: string | null | undefined): string | null {
  const parsed = displayNameSchema.safeParse(value ?? "")
  return parsed.success ? parsed.data : null
}

/**
 * Clear the pending name once a callback has signed the user in (the account now exists, or
 * already existed). Used by the `/api/auth/[...nextauth]` route around Auth.js's handlers.
 */
export function withPendingNameCleared(
  request: { nextUrl: URL; cookies: { has(name: string): boolean } },
  response: Response,
): Response {
  const isCallback = request.nextUrl.pathname.includes("/callback/")
  const location = response.headers.get("Location") ?? ""
  if (!isCallback || !request.cookies.has(PENDING_NAME_COOKIE) || location.includes("error=")) {
    return response
  }
  // Responses from Response.redirect() have immutable headers; copy before appending.
  const copy = new Response(response.body, response)
  copy.headers.append(
    "Set-Cookie",
    `${PENDING_NAME_COOKIE}=; Path=${PENDING_NAME_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`,
  )
  return copy
}

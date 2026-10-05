import "server-only"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { resolveOnboardingRedirect } from "@/lib/onboarding/gate"

import { auth } from "./auth"
import { canAccessAdmin, isActive } from "./authz"
import { AUTH_ROUTES, PATHNAME_HEADER, safeCallbackUrl, signInUrl } from "./routes"
import { parseAuthUser, type AuthUser } from "./user"

/**
 * Session helpers for server components, layouts and server actions (§4, §6).
 *
 * `proxy.ts` already redirects most unauthorised requests; these helpers enforce the same rules
 * next to the data (defence in depth) and give code the typed user.
 */

/**
 * The signed-in user, or null. Loaded once per request (React `cache`): Auth.js looks up the
 * database session joined to the `users` row, so roles and status are always current.
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const session = await auth()
  return parseAuthUser(session?.user)
})

/** The path being rendered (set by proxy.ts), to come back to after signing in. */
async function currentPath(): Promise<string | undefined> {
  const path = safeCallbackUrl((await headers()).get(PATHNAME_HEADER), "")
  return path || undefined
}

/**
 * The signed-in, active user. Signed-out visitors are redirected to `/sign-in?callbackUrl=…`;
 * suspended users to `/sign-in?error=AccountSuspended`.
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser()
  if (!user) redirect(signInUrl({ callbackUrl: await currentPath() }))
  if (!isActive(user)) redirect(signInUrl({ error: "AccountSuspended" }))
  return user
}

/** `requireUser()` plus onboarding: unfinished users go to their next onboarding step. */
export async function requireOnboardedUser(): Promise<AuthUser> {
  const user = await requireUser()
  const step = await resolveOnboardingRedirect(user)
  if (step) redirect(step)
  return user
}

/** `requireUser()` plus the admin role; other users are sent to `/app`. */
export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser()
  if (!canAccessAdmin(user)) redirect(AUTH_ROUTES.afterSignIn)
  return user
}

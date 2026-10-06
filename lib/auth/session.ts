import "server-only"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { getDb } from "@/lib/db/client"
import { resolveOnboardingRedirect } from "@/lib/onboarding/gate"

import { auth } from "./auth"
import { canAccessAdmin, isActive, isAdmin } from "./authz"
import {
  loadActiveImpersonation,
  readImpersonationClaim,
  type ActiveImpersonation,
} from "./impersonation"
import { AUTH_ROUTES, PATHNAME_HEADER, safeCallbackUrl, signInUrl } from "./routes"
import { parseAuthUser, type AuthUser } from "./user"

/**
 * Session helpers for server components, layouts and server actions (§4, §6).
 *
 * `proxy.ts` already redirects most unauthorised requests; these helpers enforce the same rules
 * next to the data (defence in depth) and give code the typed user.
 */

/**
 * Who is looking (CLAUDE.md §19.38): `realUser` is the signed-in account; `user` is whose app this
 * request renders, which differs only during an admin's read-only "view as" (`impersonation`).
 * Loaded once per request (React `cache`): Auth.js looks up the database session joined to the
 * `users` row, so roles and status are always current.
 */
export type Viewer = {
  user: AuthUser | null
  realUser: AuthUser | null
  impersonation: ActiveImpersonation | null
}

export const getViewer = cache(async (): Promise<Viewer> => {
  const session = await auth()
  const realUser = parseAuthUser(session?.user)
  if (!realUser || !isAdmin(realUser)) return { user: realUser, realUser, impersonation: null }
  const claim = await readImpersonationClaim()
  const impersonation = claim ? await loadActiveImpersonation(getDb(), { realUser, claim }) : null
  return { user: impersonation?.target ?? realUser, realUser, impersonation }
})

/**
 * The user whose app this request shows, or null when signed out: the signed-in user, or the
 * target of an admin's read-only "view as" (every mutation is refused then; lib/auth/impersonation.ts).
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  return (await getViewer()).user
})

/** The signed-in account itself, never an impersonation target (admin pages, "Stop viewing"). */
export async function getRealUser(): Promise<AuthUser | null> {
  return (await getViewer()).realUser
}

/** Whether this request is an admin's read-only "view as". */
export async function isImpersonating(): Promise<boolean> {
  return (await getViewer()).impersonation !== null
}

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

/**
 * A page loader's own authorization check (§6: every page loader calls a rule from authz.ts;
 * §19.9 defence in depth): pass the rule's answer, e.g.
 * `authorizePage(canManageOwnAccount(user))`. A refusal redirects to `fallback`, by default the
 * sign-in page's "account suspended" message, because every self-service rule starts from an
 * active account. It does not depend on `requireUser()` having checked the status already.
 */
export function authorizePage(
  allowed: boolean,
  fallback: string = signInUrl({ error: "AccountSuspended" }),
): void {
  if (!allowed) redirect(fallback)
}

/**
 * The signed-in admin; other users are sent to `/app`. It checks the real account, so `/admin/*`
 * keeps working (read-only) while the admin views the app as someone else (§19.38).
 */
export async function requireAdmin(): Promise<AuthUser> {
  await requireUser()
  const user = await getRealUser()
  if (!user || !canAccessAdmin(user)) redirect(AUTH_ROUTES.afterSignIn)
  return user
}

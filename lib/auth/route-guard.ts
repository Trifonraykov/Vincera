import { canAccessAdmin, isActive } from "./authz"
import { AUTH_ROUTES, safeCallbackUrl, signInUrl } from "./routes"
import type { AuthUser } from "./user"

/**
 * Route-level access rules applied by `proxy.ts` (§6). Pure: takes the URL and the signed-in user
 * (null when signed out) and returns what to do. Layouts enforce the same rules again with
 * `requireUser()` / `requireAdmin()` (defence in depth).
 *
 * - `/app/*`, `/onboarding/*`, `/admin/*` need a session; signed-out users go to
 *   `/sign-in?callbackUrl=<where they were going>`.
 * - Suspended users are sent to `/sign-in?error=AccountSuspended`.
 * - `/admin/*` needs the admin role; other users are redirected to `/app`.
 * - `/app/*` sends users with unfinished onboarding to the next onboarding step. Deciding that may
 *   need the database, so the caller injects `resolveOnboardingStep` (the proxy passes
 *   `resolveOnboardingRedirect` from lib/onboarding/gate.ts; tests pass a stub).
 * - Signed-in users opening `/sign-in` or `/sign-up` go to their callbackUrl or `/app`, unless the
 *   page is showing an error.
 */

export type GuardDecision = { type: "next" } | { type: "redirect"; to: string }

export type GuardedArea = "app" | "onboarding" | "admin" | "auth"

const NEXT: GuardDecision = { type: "next" }
const redirectTo = (to: string): GuardDecision => ({ type: "redirect", to })

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** The guarded area of a path. Keep proxy.ts's `matcher` in sync with this. */
export function areaOf(pathname: string): GuardedArea | null {
  if (isUnder(pathname, "/app")) return "app"
  if (isUnder(pathname, "/onboarding")) return "onboarding"
  if (isUnder(pathname, "/admin")) return "admin"
  if (pathname === AUTH_ROUTES.signIn || pathname === AUTH_ROUTES.signUp) return "auth"
  return null
}

/** Where `/app` must send `user` first (an onboarding step), or null to let them in. */
export type OnboardingStepResolver = (user: AuthUser) => Promise<string | null>

export async function guardRoute(
  url: { pathname: string; search: string; searchParams: URLSearchParams },
  user: AuthUser | null,
  resolveOnboardingStep: OnboardingStepResolver,
): Promise<GuardDecision> {
  const area = areaOf(url.pathname)
  if (area === null) return NEXT

  if (area === "auth") {
    if (user && isActive(user) && !url.searchParams.has("error")) {
      return redirectTo(safeCallbackUrl(url.searchParams.get("callbackUrl")))
    }
    return NEXT
  }

  if (!user) return redirectTo(signInUrl({ callbackUrl: `${url.pathname}${url.search}` }))
  if (!isActive(user)) return redirectTo(signInUrl({ error: "AccountSuspended" }))

  if (area === "admin" && !canAccessAdmin(user)) return redirectTo(AUTH_ROUTES.afterSignIn)

  if (area === "app") {
    const step = await resolveOnboardingStep(user)
    if (step) return redirectTo(step)
  }
  return NEXT
}

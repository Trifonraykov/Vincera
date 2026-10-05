import type { NextAuthRequest } from "next-auth"
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server"

import { auth } from "@/lib/auth/auth"
import { guardRoute } from "@/lib/auth/route-guard"
import { PATHNAME_HEADER, sameOriginRedirectUrl } from "@/lib/auth/routes"
import { parseAuthUser } from "@/lib/auth/user"
import { resolveOnboardingRedirect } from "@/lib/onboarding/gate"

/**
 * Next.js 16 proxy (formerly middleware; runs on Node.js). Applies the route rules from
 * lib/auth/route-guard.ts (§6) before pages render:
 * `/app/*`, `/onboarding/*` need a session, `/admin/*` the admin role, `/app/*` finished
 * onboarding, and signed-in users skip `/sign-in` / `/sign-up`.
 *
 * Wrapping with Auth.js `auth()` validates the database session (one query joining `users`) and
 * refreshes the session cookie's expiry. For `/app/*`, users who have not finished onboarding cost
 * one more query (their onboarding snapshot, lib/onboarding/gate.ts). Layouts and pages check again with
 * requireUser()/requireAdmin() (defence in depth).
 */
// The unused `_event` parameter selects Auth.js's middleware overload (not the route-handler one).
const guarded = auth(async (request: NextAuthRequest, _event: NextFetchEvent) => {
  const user = parseAuthUser(request.auth?.user)
  const decision = await guardRoute(request.nextUrl, user, (u) => resolveOnboardingRedirect(u))
  if (decision.type === "redirect") {
    return NextResponse.redirect(sameOriginRedirectUrl(decision.to, request.nextUrl.href))
  }

  const headers = new Headers(request.headers)
  headers.set(PATHNAME_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.next({ request: { headers } })
})

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  // With a per-request config (lib/auth/auth.ts), Auth.js's `auth(handler)` resolves to the
  // middleware asynchronously, although its types say it returns it directly; awaiting
  // handles both.
  const middleware = await guarded
  return middleware(request, event)
}

export const config = {
  // Keep in sync with areaOf() in lib/auth/route-guard.ts.
  matcher: ["/app/:path*", "/onboarding/:path*", "/admin/:path*", "/sign-in", "/sign-up"],
}

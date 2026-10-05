import type { NextRequest } from "next/server"

import { handlers } from "@/lib/auth/auth"
import { withPendingNameCleared } from "@/lib/auth/pending-name"

/**
 * Auth.js endpoints (`/api/auth/*`): magic-link and OAuth callbacks, sign-out, session, CSRF.
 *
 * Signing in starts only from our server actions (lib/auth/actions.ts), which validate input and
 * run Auth.js in-process, never through this route. Auth.js's own HTTP sign-in endpoint
 * (`POST /api/auth/signin/<provider>`) would skip that validation and the OAuth rate limit, so it
 * is closed. Magic-link rate limiting does not depend on this: it lives in the signIn callback.
 */

const SIGN_IN_ACTION = /^\/api\/auth\/signin(\/|$)/

export async function GET(request: NextRequest): Promise<Response> {
  return withPendingNameCleared(request, await handlers.GET(request))
}

export async function POST(request: NextRequest): Promise<Response> {
  if (SIGN_IN_ACTION.test(request.nextUrl.pathname)) {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
  }
  return withPendingNameCleared(request, await handlers.POST(request))
}

import { mobileEndpoints } from "@/lib/mobile-api/endpoints"
import { handleMobileRequest } from "@/lib/mobile-api/router"

/**
 * The native iPhone app's JSON API, `/api/mobile/v1/*` (CLAUDE.md §19.44). Every path is routed by
 * lib/mobile-api/router.ts; the endpoints and their Zod contract live in lib/mobile-api/. Bearer
 * tokens (never cookies), so the proxy's session redirects do not apply here (its matcher does not
 * include `/api`).
 */

export const dynamic = "force-dynamic"

const endpoints = mobileEndpoints()

const handle = (request: Request) => handleMobileRequest(request, endpoints)

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const OPTIONS = handle

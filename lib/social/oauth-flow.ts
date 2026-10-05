import "server-only"

import { NextResponse, type NextRequest } from "next/server"

import { isActive } from "@/lib/auth/authz"
import { safeCallbackUrl, signInUrl } from "@/lib/auth/routes"
import type { AuthUser } from "@/lib/auth/user"
import type { DbOrTx } from "@/lib/db/client"
import { enqueue } from "@/lib/jobs/enqueue"
import { reportError } from "@/lib/observability"
import { rateLimit, type RateLimitRule } from "@/lib/ratelimit"
import { getStorage } from "@/lib/storage/r2"
import { absoluteUrl } from "@/lib/urls"

import { canConnectSocial } from "./authz"
import { withConnectResult, type ConnectErrorCode } from "./connect-errors"
import { SocialConnectError, upsertOAuthConnection } from "./connections"
import { SocialProviderError, SocialRetryableError, socialErrorCode } from "./errors"
import {
  beginOAuthState,
  clearedOAuthStateCookie,
  DEFAULT_CONNECT_RETURN_TO,
  oauthStateCookieName,
  verifyOAuthState,
  type OAuthCookie,
} from "./oauth-cookie"
import { getProvider } from "./registry"
import {
  socialProviderIdSchema,
  SocialTokenError,
  type SocialProvider,
  type SocialProviderId,
} from "./types"

/**
 * The OAuth data-connection flow (§7.1, §14; CLAUDE.md §19.13, §19.14), as plain functions the
 * route handlers call with the signed-in user (tests call them with a test database):
 *
 * - `GET /api/oauth/[provider]/start?returnTo=<path>`: signed in, allowed for the user's roles
 *   (YouTube/Instagram/TikTok → creator; GitHub → builder or creator), rate limited. Sets the
 *   encrypted state cookie (state + PKCE verifier, bound to the user) and redirects to the
 *   provider (or, for a fake provider, to the dev consent page).
 * - `GET /api/oauth/[provider]/callback`: checks the state (timing-safe) and the user, exchanges
 *   the code, fetches the profile, upserts `social_connections` (encrypted tokens,
 *   `social.connected`), enqueues `social/sync`, and redirects to `returnTo?connected=<provider>`
 *   or `returnTo?error=<code>&provider=<provider>` (messages in lib/social/connect-errors.ts).
 */

/** Starting a connection: 10 per user per 10 minutes (each one is a provider round trip). */
export const OAUTH_START_RATE_LIMIT: RateLimitRule = { limit: 10, window: "10 m" }

export type OAuthFlowDeps = {
  /** The signed-in user (`getCurrentUser()`), or null. */
  user: AuthUser | null
  db: DbOrTx
  /** Defaults to the registry (live or fake per provider). */
  providerFor?: (provider: SocialProviderId) => SocialProvider
  /** Defaults to `enqueue("social/sync.requested", { reason: "connected" })`. */
  enqueueSync?: (connectionId: string) => Promise<void>
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } })
}

function parseProvider(value: string): SocialProviderId | null {
  const parsed = socialProviderIdSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** A 303 to an in-app path (or an absolute provider URL), never cached. */
function redirectTo(location: string, cookie?: OAuthCookie): NextResponse {
  const url = location.startsWith("/") ? absoluteUrl(location) : location
  const response = NextResponse.redirect(url, 303)
  response.headers.set("Cache-Control", "no-store")
  if (cookie) response.cookies.set(cookie.name, cookie.value, cookie.options)
  return response
}

function failTo(
  returnTo: string,
  provider: SocialProviderId,
  error: ConnectErrorCode,
  cookie?: OAuthCookie,
): NextResponse {
  return redirectTo(withConnectResult(returnTo, { error, provider }), cookie)
}

export async function oauthStartResponse(
  request: NextRequest,
  providerParam: string,
  deps: OAuthFlowDeps,
): Promise<Response> {
  const provider = parseProvider(providerParam)
  if (!provider) return notFound()
  const returnTo = safeCallbackUrl(
    request.nextUrl.searchParams.get("returnTo"),
    DEFAULT_CONNECT_RETURN_TO,
  )

  const { user } = deps
  if (!user) return redirectTo(signInUrl({ callbackUrl: returnTo }))
  if (!isActive(user)) return redirectTo(signInUrl({ error: "AccountSuspended" }))
  if (!canConnectSocial(user, provider)) return failTo(returnTo, provider, "not_allowed")

  const limit = await rateLimit("oauth-start", user.id, OAUTH_START_RATE_LIMIT)
  if (!limit.success) return failTo(returnTo, provider, "rate_limited")

  const social = (deps.providerFor ?? getProvider)(provider)
  const { state, pkce, cookie } = beginOAuthState({
    provider,
    userId: user.id,
    returnTo,
    usePkce: social.supportsPkce,
  })
  return redirectTo(social.authUrl(state, pkce), cookie)
}

export async function oauthCallbackResponse(
  request: NextRequest,
  providerParam: string,
  deps: OAuthFlowDeps,
): Promise<Response> {
  const provider = parseProvider(providerParam)
  if (!provider) return notFound()
  // Every answer from here on deletes the state cookie: it is single use.
  const cleared = clearedOAuthStateCookie(provider)
  const params = request.nextUrl.searchParams

  const { user } = deps
  if (!user) return redirectTo(signInUrl({ callbackUrl: DEFAULT_CONNECT_RETURN_TO }), cleared)
  if (!isActive(user)) return redirectTo(signInUrl({ error: "AccountSuspended" }), cleared)

  const check = verifyOAuthState({
    provider,
    userId: user.id,
    cookieValue: request.cookies.get(oauthStateCookieName(provider))?.value,
    state: params.get("state"),
  })
  if (!check.ok) {
    const error = check.reason === "expired" ? "session_expired" : "state_invalid"
    return failTo(check.returnTo, provider, error, cleared)
  }
  const { returnTo } = check

  const providerError = params.get("error")
  if (providerError) {
    const error = providerError === "access_denied" ? "access_denied" : "provider_error"
    return failTo(returnTo, provider, error, cleared)
  }
  if (!canConnectSocial(user, provider)) return failTo(returnTo, provider, "not_allowed", cleared)
  const code = params.get("code")
  if (!code) return failTo(returnTo, provider, "invalid_code", cleared)

  const social = (deps.providerFor ?? getProvider)(provider)
  let connectionId: string
  try {
    const tokens = await social.exchangeCode(
      code,
      check.codeVerifier ? { codeVerifier: check.codeVerifier } : undefined,
    )
    const profile = await social.fetchProfile(tokens)
    const result = await upsertOAuthConnection(deps.db, {
      userId: user.id,
      provider,
      tokens,
      profile,
    })
    connectionId = result.connection.id
    if (result.replacedEvidenceKey) await deleteEvidence(result.replacedEvidenceKey)
  } catch (error) {
    if (error instanceof SocialConnectError) return failTo(returnTo, provider, error.code, cleared)
    const known =
      error instanceof SocialTokenError ||
      error instanceof SocialRetryableError ||
      error instanceof SocialProviderError
    const errorCode = socialErrorCode(error)
    // Expected user-side outcomes (an expired code, a channel-less account) are not reported.
    const expected = ["invalid_code", "no_channel", "scope_missing", "not_eligible", "rate_limited"]
    if (!known || !expected.includes(errorCode)) {
      reportError(error, { tags: { area: "social", step: "oauth_callback", provider } })
    }
    return failTo(returnTo, provider, errorCode, cleared)
  }

  try {
    await (deps.enqueueSync ?? enqueueConnectedSync)(connectionId)
  } catch (error) {
    // The connection is stored; the daily sync picks it up if the first sync could not be queued.
    reportError(error, { tags: { area: "social", step: "enqueue_sync", provider } })
  }
  return redirectTo(withConnectResult(returnTo, { connected: provider }), cleared)
}

async function enqueueConnectedSync(connectionId: string): Promise<void> {
  await enqueue("social/sync.requested", { connectionId, reason: "connected" })
}

/** Best effort: a manual entry's screenshot is no longer needed once OAuth verified the account. */
async function deleteEvidence(key: string): Promise<void> {
  try {
    await getStorage().deleteObject(key)
  } catch (error) {
    reportError(error, { tags: { area: "social", step: "delete_evidence" } })
  }
}

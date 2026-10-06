import "server-only"

import { createHash, timingSafeEqual } from "node:crypto"

import { z } from "zod"

import { safeCallbackUrl } from "@/lib/auth/routes"
import { now } from "@/lib/clock"
import { decrypt, encrypt, randomToken } from "@/lib/crypto"
import { env } from "@/lib/env"

import { createCodeVerifier, pkceChallenge } from "./pkce"
import { socialProviderIdSchema, type PkceChallenge, type SocialProviderId } from "./types"

/**
 * OAuth `state` + PKCE storage for the data-connection flow (§14, CLAUDE.md §19.13):
 * `/api/oauth/[provider]/start` creates them and sets this cookie; the callback reads it back.
 *
 * The cookie is AES-GCM encrypted (lib/crypto.ts) with the provider as additional data, httpOnly,
 * SameSite=Lax (the provider's redirect back is a top-level GET), scoped to `/api/oauth/<provider>`
 * and valid for 10 minutes. It holds the state, the PKCE verifier (never sent anywhere but the
 * provider's token endpoint), the provider, the user id it was issued to, and where to return.
 */

export const OAUTH_STATE_TTL_SECONDS = 600
/** Where a connection flow returns when the caller gives no (valid) `returnTo`. */
export const DEFAULT_CONNECT_RETURN_TO = "/app/settings/connections"

const payloadSchema = z.object({
  v: z.literal(1),
  provider: socialProviderIdSchema,
  userId: z.string().min(1),
  state: z.string().min(1),
  codeVerifier: z.string().min(1).nullable(),
  returnTo: z.string(),
  /** Unix ms. */
  exp: z.number().int(),
})
type Payload = z.infer<typeof payloadSchema>

export type OAuthCookie = {
  name: string
  value: string
  options: {
    httpOnly: true
    sameSite: "lax"
    secure: boolean
    path: string
    maxAge: number
  }
}

export function oauthStateCookieName(provider: SocialProviderId): string {
  return `oauth_state_${provider}`
}

export function oauthStateCookiePath(provider: SocialProviderId): string {
  return `/api/oauth/${provider}`
}

function aad(provider: SocialProviderId): string {
  return `social_oauth_state:${provider}`
}

function cookie(provider: SocialProviderId, value: string, maxAge: number): OAuthCookie {
  return {
    name: oauthStateCookieName(provider),
    value,
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(env.NEXT_PUBLIC_APP_URL).protocol === "https:",
      path: oauthStateCookiePath(provider),
      maxAge,
    },
  }
}

export type OAuthStateStart = {
  /** Send as the `state` authorization parameter. */
  state: string
  /** Pass to `provider.authUrl(state, pkce)`; undefined when the provider has no PKCE. */
  pkce: PkceChallenge | undefined
  /** Set on the redirect response (`response.cookies.set(name, value, options)`). */
  cookie: OAuthCookie
}

/** Create the state (and PKCE verifier) for a new connection flow and the cookie holding them. */
export function beginOAuthState(input: {
  provider: SocialProviderId
  userId: string
  returnTo: string | null | undefined
  usePkce: boolean
}): OAuthStateStart {
  const codeVerifier = input.usePkce ? createCodeVerifier() : null
  const payload: Payload = {
    v: 1,
    provider: input.provider,
    userId: input.userId,
    state: randomToken(32),
    codeVerifier,
    returnTo: safeCallbackUrl(input.returnTo, DEFAULT_CONNECT_RETURN_TO),
    exp: now().getTime() + OAUTH_STATE_TTL_SECONDS * 1000,
  }
  const value = encrypt(JSON.stringify(payload), { aad: aad(input.provider) })
  return {
    state: payload.state,
    pkce: codeVerifier ? pkceChallenge(codeVerifier) : undefined,
    cookie: cookie(input.provider, value, OAUTH_STATE_TTL_SECONDS),
  }
}

/** An expired cookie that deletes the state cookie; set it on every callback response. */
export function clearedOAuthStateCookie(provider: SocialProviderId): OAuthCookie {
  return cookie(provider, "", 0)
}

export type OAuthStateFailure =
  "missing" | "invalid" | "expired" | "state_mismatch" | "user_mismatch" | "provider_mismatch"

export type OAuthStateCheck =
  | { ok: true; codeVerifier: string | null; returnTo: string }
  | {
      ok: false
      reason: OAuthStateFailure
      /** Where to send the user with the error; the default when the cookie is unreadable. */
      returnTo: string
    }

/** Constant-time string comparison (hashes first, so lengths never leak or throw). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()
  return timingSafeEqual(digest(a), digest(b))
}

/**
 * Check the callback's `state` against the cookie for this provider and user. The comparison is
 * timing-safe; any failure means the callback must not exchange the code.
 */
export function verifyOAuthState(input: {
  provider: SocialProviderId
  userId: string
  cookieValue: string | null | undefined
  state: string | null | undefined
}): OAuthStateCheck {
  const fail = (reason: OAuthStateFailure, returnTo = DEFAULT_CONNECT_RETURN_TO) =>
    ({ ok: false, reason, returnTo }) as const
  if (!input.cookieValue) return fail("missing")

  let payload: Payload
  try {
    const parsed = payloadSchema.safeParse(
      JSON.parse(decrypt(input.cookieValue, { aad: aad(input.provider) })),
    )
    if (!parsed.success) return fail("invalid")
    payload = parsed.data
  } catch {
    return fail("invalid")
  }

  const returnTo = safeCallbackUrl(payload.returnTo, DEFAULT_CONNECT_RETURN_TO)
  if (payload.provider !== input.provider) return fail("provider_mismatch", returnTo)
  if (payload.exp <= now().getTime()) return fail("expired", returnTo)
  if (!input.state || !timingSafeStringEqual(input.state, payload.state)) {
    return fail("state_mismatch", returnTo)
  }
  if (!timingSafeStringEqual(input.userId, payload.userId)) return fail("user_mismatch", returnTo)
  return { ok: true, codeVerifier: payload.codeVerifier, returnTo }
}

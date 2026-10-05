import "server-only"

import { env } from "@/lib/env"

import { isProviderFakeSafe } from "./registry"
import type { SocialProviderId, TokenSet } from "./types"

/**
 * Best-effort token revocation when a user disconnects an account (§14 "Disconnecting a social
 * account deletes its tokens and snapshots"; CLAUDE.md §19.14). Our copy of the tokens is deleted
 * either way; revoking also removes the app from the user's account on the provider's side.
 * Never throws and never includes a token in an error.
 *
 * - YouTube (Google): `POST https://oauth2.googleapis.com/revoke` with the refresh token (which
 *   revokes the whole grant) or the access token.
 * - GitHub (OAuth App): `DELETE /applications/{client_id}/grant` with the app's Basic auth.
 * - TikTok: `POST https://open.tiktokapis.com/v2/oauth/revoke/`.
 * - Instagram (API with Instagram Login) has no revocation endpoint; users remove the app in
 *   their Instagram settings.
 *
 * Fake providers have nothing to revoke (their tokens are self-contained signed values), so the
 * call is skipped unless a test injects `fetch`.
 */

export type RevokeOutcome = "revoked" | "failed" | "unsupported" | "skipped_fake"

export type RevokeFetch = (url: string, init: RequestInit) => Promise<Response>

const REVOKE_TIMEOUT_MS = 10_000

type RevokeRequest = { url: string; init: RequestInit }

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString()
}

function revokeRequest(provider: SocialProviderId, tokens: TokenSet): RevokeRequest | null {
  switch (provider) {
    case "youtube":
      return {
        url: "https://oauth2.googleapis.com/revoke",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form({ token: tokens.refreshToken ?? tokens.accessToken }),
        },
      }
    case "github": {
      const clientId = env.GITHUB_DATA_CLIENT_ID ?? ""
      const secret = env.GITHUB_DATA_CLIENT_SECRET ?? ""
      return {
        url: `https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`,
        init: {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
            "Content-Type": "application/json",
            "User-Agent": env.APP_NAME,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ access_token: tokens.accessToken }),
        },
      }
    }
    case "tiktok":
      return {
        url: "https://open.tiktokapis.com/v2/oauth/revoke/",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form({
            client_key: env.TIKTOK_CLIENT_KEY ?? "",
            client_secret: env.TIKTOK_CLIENT_SECRET ?? "",
            token: tokens.accessToken,
          }),
        },
      }
    case "instagram":
      return null
  }
}

export async function revokeTokens(
  provider: SocialProviderId,
  tokens: TokenSet,
  deps: { fetch?: RevokeFetch } = {},
): Promise<RevokeOutcome> {
  const request = revokeRequest(provider, tokens)
  if (!request) return "unsupported"
  if (!deps.fetch && isProviderFakeSafe(provider)) return "skipped_fake"
  const send: RevokeFetch = deps.fetch ?? ((url, init) => fetch(url, init))
  try {
    const response = await send(request.url, {
      ...request.init,
      cache: "no-store",
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    })
    // An already-invalid token answers 400/404: there is nothing left to revoke either way.
    return response.ok ? "revoked" : "failed"
  } catch {
    return "failed"
  }
}

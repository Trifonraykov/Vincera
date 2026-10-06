import "server-only"

import type { JsonValue } from "@/lib/db/schema/types"
import { now } from "@/lib/clock"

import { GITHUB_ENDPOINTS } from "../github"
import type { SocialFetch, SocialRequestInit } from "../http"
import { INSTAGRAM_ENDPOINTS } from "../instagram"
import { codeChallengeFor } from "../pkce"
import { TIKTOK_ENDPOINTS } from "../tiktok"
import type { SocialProviderId } from "../types"
import { YOUTUBE_ENDPOINTS } from "../youtube"
import {
  defaultFixturesRoot,
  loadFakeFixture,
  type FakeFixture,
  type RecordedReply,
  type RecordedResponse,
} from "./fixtures"
import { isFakeValueExpired, mintFakeValue, readFakeValue, type FakeValueKind } from "./signing"

/**
 * The fake social transport (§19.3): a `SocialFetch` that answers the providers' real endpoint
 * URLs from recorded fixtures (lib/social/fake/fixtures.ts) instead of the network. The provider
 * code is the live code; only the transport differs.
 *
 * - Token endpoints validate what a real provider would: the code was minted by the fake
 *   authorize page for this provider, has not expired (10 min), is redeemed with the same
 *   `redirect_uri`, and passes PKCE when it was issued with a challenge; client credentials are
 *   present. Refreshes need a valid fake refresh token. Replies come from the fixture's `oauth`
 *   templates with fresh fake tokens filled in.
 * - API calls need a fake access token (bearer header, or `access_token` for Instagram) that has
 *   not expired on the app clock, so a mocked clock exercises token refresh. Fixture account =
 *   the one encoded in the token.
 * - Failures use each provider's real error shapes, so the real error classification runs.
 */

type Reply = { status: number; body: JsonValue; headers?: Record<string, string> }

const FBTRACE = "AfakeTraceId0000"
const LOG_ID = "202610050000000000FAKE0000000000"

type ProviderReplies = {
  /** The code or refresh token is invalid/expired/reused. */
  badGrant: Reply
  /** Refresh with a dead refresh token (defaults to badGrant). */
  badRefresh?: Reply
  /** Client credentials missing. */
  badClient: Reply
  /** API call without a valid access token. */
  unauthorized: Reply
  /** No recorded response for the request. */
  notFound: Reply
}

const REPLIES: Record<SocialProviderId, ProviderReplies> = {
  youtube: {
    badGrant: { status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } },
    badClient: {
      status: 401,
      body: { error: "invalid_client", error_description: "The OAuth client was not found." },
    },
    unauthorized: {
      status: 401,
      body: {
        error: {
          code: 401,
          message:
            "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
          errors: [
            {
              message: "Invalid Credentials",
              domain: "global",
              reason: "authError",
              location: "Authorization",
              locationType: "header",
            },
          ],
          status: "UNAUTHENTICATED",
        },
      },
    },
    notFound: {
      status: 404,
      body: {
        error: {
          code: 404,
          message: "Requested entity was not found.",
          errors: [
            { message: "Requested entity was not found.", domain: "global", reason: "notFound" },
          ],
          status: "NOT_FOUND",
        },
      },
    },
  },
  instagram: {
    badGrant: {
      status: 400,
      body: {
        error_type: "OAuthException",
        code: 400,
        error_message: "Invalid authorization code",
      },
    },
    badRefresh: {
      status: 400,
      body: {
        error: {
          message: "Error validating access token: Session has expired.",
          type: "OAuthException",
          code: 190,
          error_subtype: 463,
          fbtrace_id: FBTRACE,
        },
      },
    },
    badClient: {
      status: 400,
      body: {
        error_type: "OAuthException",
        code: 101,
        error_message: "Error validating client secret.",
      },
    },
    unauthorized: {
      status: 400,
      body: {
        error: {
          message: "Invalid OAuth access token - Cannot parse access token",
          type: "OAuthException",
          code: 190,
          fbtrace_id: FBTRACE,
        },
      },
    },
    notFound: {
      status: 400,
      body: {
        error: {
          message: "Unsupported get request.",
          type: "GraphMethodException",
          code: 100,
          error_subtype: 33,
          fbtrace_id: FBTRACE,
        },
      },
    },
  },
  tiktok: {
    badGrant: {
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "Authorization code is expired.",
        log_id: LOG_ID,
      },
    },
    badClient: {
      status: 401,
      body: {
        error: "invalid_client",
        error_description: "Client key or secret is incorrect.",
        log_id: LOG_ID,
      },
    },
    unauthorized: {
      status: 401,
      body: {
        data: {},
        error: {
          code: "access_token_invalid",
          message: "The access token is invalid or not found in the request.",
          log_id: LOG_ID,
        },
      },
    },
    notFound: {
      status: 404,
      body: { data: {}, error: { code: "invalid_params", message: "Not found", log_id: LOG_ID } },
    },
  },
  github: {
    // GitHub's token endpoint reports errors with HTTP 200.
    badGrant: {
      status: 200,
      body: {
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
        error_uri:
          "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#bad-verification-code",
      },
    },
    badRefresh: {
      status: 200,
      body: {
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired.",
      },
    },
    badClient: {
      status: 200,
      body: {
        error: "incorrect_client_credentials",
        error_description: "The client_id and/or client_secret passed are incorrect.",
      },
    },
    unauthorized: {
      status: 401,
      body: {
        message: "Bad credentials",
        documentation_url: "https://docs.github.com/rest",
        status: "401",
      },
    },
    notFound: {
      status: 404,
      body: {
        message: "Not Found",
        documentation_url: "https://docs.github.com/rest",
        status: "404",
      },
    },
  },
}

/** Where each provider exchanges codes and refresh tokens (Instagram: codes only). */
const TOKEN_ENDPOINT: Record<SocialProviderId, string> = {
  youtube: YOUTUBE_ENDPOINTS.token,
  instagram: INSTAGRAM_ENDPOINTS.shortLivedToken,
  tiktok: TIKTOK_ENDPOINTS.token,
  github: GITHUB_ENDPOINTS.token,
}

/** Lifetime of Instagram's short-lived token (its reply has no expires_in). */
const SHORT_LIVED_TTL_SECONDS = 3600

function respond(reply: Reply | RecordedReply): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "Content-Type": "application/json", ...reply.headers },
  })
}

function numberField(body: JsonValue, key: string): number | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null
  const value = body[key]
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

function fillPlaceholders(value: JsonValue, tokens: Record<string, string>): JsonValue {
  if (typeof value === "string") return tokens[value] ?? value
  if (Array.isArray(value)) return value.map((item) => fillPlaceholders(item, tokens))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillPlaceholders(item, tokens)]),
    )
  }
  return value
}

/** A recorded token reply with fresh fake tokens in place of the placeholders. */
function issueTokens(
  provider: SocialProviderId,
  account: string,
  template: RecordedReply,
  accessKind: FakeValueKind,
  at: Date,
): Response {
  const accessTtl =
    numberField(template.body, "expires_in") ??
    (accessKind === "short" ? SHORT_LIVED_TTL_SECONDS : null)
  const refreshTtl =
    numberField(template.body, "refresh_expires_in") ??
    numberField(template.body, "refresh_token_expires_in")
  const mint = (kind: FakeValueKind, ttlSeconds: number | null) =>
    mintFakeValue(kind, { provider, account, issuedAt: at, ttlSeconds })
  return respond({
    ...template,
    body: fillPlaceholders(template.body, {
      "{{access_token}}": mint(accessKind, accessTtl),
      "{{refresh_token}}": mint("refresh", refreshTtl),
    }),
  })
}

function matchRecorded(
  responses: readonly RecordedResponse[],
  method: string,
  endpoint: string,
  query: Record<string, string>,
): RecordedResponse | undefined {
  let best: { response: RecordedResponse; score: number } | undefined
  for (const response of responses) {
    if (response.method !== method || response.url !== endpoint) continue
    const wanted = Object.entries(response.query ?? {})
    if (!wanted.every(([key, value]) => query[key] === value)) continue
    if (!best || wanted.length > best.score) best = { response, score: wanted.length }
  }
  return best?.response
}

export type FakeSocialFetchOptions = {
  /** Defaults to `tests/fixtures/social` under the working directory. */
  fixturesRoot?: string
}

export function createFakeSocialFetch(
  provider: SocialProviderId,
  options: FakeSocialFetchOptions = {},
): SocialFetch {
  const root = options.fixturesRoot ?? defaultFixturesRoot()
  const replies = REPLIES[provider]
  const load = (account: string): Promise<FakeFixture | null> =>
    loadFakeFixture(provider, account, root)

  async function tokenEndpoint(form: Record<string, string>, at: Date): Promise<Response> {
    const clientParam = provider === "tiktok" ? "client_key" : "client_id"
    if (!form[clientParam] || !form.client_secret) return respond(replies.badClient)

    if (form.grant_type === "refresh_token") {
      const badRefresh = replies.badRefresh ?? replies.badGrant
      if (provider === "instagram") return respond(replies.badGrant)
      const value = readFakeValue(form.refresh_token, "refresh")
      if (!value || value.p !== provider || isFakeValueExpired(value, at)) {
        return respond(badRefresh)
      }
      const fixture = await load(value.a)
      if (!fixture) return respond(badRefresh)
      return issueTokens(provider, value.a, fixture.oauth.refresh, "access", at)
    }

    // GitHub's code exchange sends no grant_type; the others must say authorization_code.
    if (provider !== "github" && form.grant_type !== "authorization_code") {
      return respond(replies.badGrant)
    }
    const code = readFakeValue(form.code?.replace(/#_$/, ""), "code")
    const pkceOk =
      !code?.cc ||
      (form.code_verifier !== undefined && codeChallengeFor(form.code_verifier) === code.cc)
    if (
      !code ||
      code.p !== provider ||
      isFakeValueExpired(code, at) ||
      code.ru !== form.redirect_uri ||
      !pkceOk
    ) {
      return respond(replies.badGrant)
    }
    const fixture = await load(code.a)
    if (!fixture) return respond(replies.badGrant)
    return issueTokens(
      provider,
      code.a,
      fixture.oauth.token,
      provider === "instagram" ? "short" : "access",
      at,
    )
  }

  /** Instagram: short-lived → long-lived (`ig_exchange_token`) and `ig_refresh_token`. */
  async function instagramTokenCall(
    endpoint: string,
    query: Record<string, string>,
    at: Date,
  ): Promise<Response> {
    const exchanging = endpoint === INSTAGRAM_ENDPOINTS.longLivedToken
    if (exchanging && (query.grant_type !== "ig_exchange_token" || !query.client_secret)) {
      return respond(replies.badClient)
    }
    if (!exchanging && query.grant_type !== "ig_refresh_token") return respond(replies.badClient)
    const value = readFakeValue(query.access_token, exchanging ? "short" : "access")
    if (!value || value.p !== provider || isFakeValueExpired(value, at)) {
      return respond(replies.badRefresh ?? replies.unauthorized)
    }
    const fixture = await load(value.a)
    const template = exchanging ? fixture?.oauth.longLived : fixture?.oauth.refresh
    if (!template) return respond(replies.unauthorized)
    return issueTokens(provider, value.a, template, "access", at)
  }

  async function apiCall(
    init: SocialRequestInit,
    endpoint: string,
    query: Record<string, string>,
    at: Date,
  ): Promise<Response> {
    const authorization = new Headers(init.headers).get("authorization")
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
    const { access_token: queryToken, ...params } = query
    const value = readFakeValue(bearer ?? queryToken, "access")
    if (!value || value.p !== provider || isFakeValueExpired(value, at)) {
      return respond(replies.unauthorized)
    }
    const fixture = await load(value.a)
    if (!fixture) return respond(replies.unauthorized)
    const recorded = matchRecorded(fixture.responses, init.method, endpoint, params)
    if (!recorded) {
      // Method and path only: the query may hold a token.
      console.warn(`[fake-social] no recorded ${provider} reply for ${init.method} ${endpoint}`)
      return respond(replies.notFound)
    }
    return respond(recorded)
  }

  return async (url, init) => {
    const at = now()
    const target = new URL(url)
    const endpoint = `${target.origin}${target.pathname}`
    const query = Object.fromEntries(target.searchParams)
    const isForm = new Headers(init.headers)
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
    const form: Record<string, string> = isForm
      ? Object.fromEntries(new URLSearchParams(init.body ?? ""))
      : {}

    if (init.method === "POST" && endpoint === TOKEN_ENDPOINT[provider]) {
      return tokenEndpoint(form, at)
    }
    if (
      provider === "instagram" &&
      init.method === "GET" &&
      (endpoint === INSTAGRAM_ENDPOINTS.longLivedToken || endpoint === INSTAGRAM_ENDPOINTS.refresh)
    ) {
      return instagramTokenCall(endpoint, query, at)
    }
    return apiCall(init, endpoint, query, at)
  }
}

/** Fake authorization codes live 10 minutes, like GitHub's (Google's are shorter, IG's 1h). */
export const FAKE_CODE_TTL_SECONDS = 600

/** Mint the code the fake authorize page sends back to our callback. */
export function mintFakeAuthorizationCode(input: {
  provider: SocialProviderId
  account: string
  redirectUri: string
  codeChallenge?: string
}): string {
  return mintFakeValue("code", {
    provider: input.provider,
    account: input.account,
    issuedAt: now(),
    ttlSeconds: FAKE_CODE_TTL_SECONDS,
    codeChallenge: input.codeChallenge,
    redirectUri: input.redirectUri,
  })
}

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SocialProviderError, SocialRetryableError, SocialTokenError } from "@/lib/social/errors"
import { GITHUB_STATS_QUERY } from "@/lib/social/github"
import { mintFakeAuthorizationCode } from "@/lib/social/fake/transport"
import { createCodeVerifier, pkceChallenge } from "@/lib/social/pkce"
import { gitHubStatsFromRaw, githubRawSchema } from "@/lib/social/raw"
import { tokenNeedsRefresh } from "@/lib/social/tokens"
import { audienceSnapshotInputSchema } from "@/lib/social/types"

import {
  callbackUrl,
  connect,
  fakeProvider,
  jsonResponse,
  liveLikeProvider,
  NOW,
  rejectionOf,
  resetSocialTest,
  setClock,
  setupSocialTest,
} from "./helpers"

beforeEach(() => setupSocialTest())
afterEach(() => resetSocialTest())

describe("GitHub: authorization URL", () => {
  it("requests no scope (public, read-only) and uses PKCE S256", () => {
    const provider = liveLikeProvider("github")
    const url = new URL(
      provider.authUrl("state-g", { codeChallenge: "c".repeat(43), codeChallengeMethod: "S256" }),
    )
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.has("scope")).toBe(false)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "live-github-client",
      redirect_uri: callbackUrl("github"),
      state: "state-g",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    })
    expect(provider.scopes).toEqual([])
  })
})

describe("GitHub: tokens", () => {
  it("exchanges the code with its verifier for a non-expiring token", async () => {
    const { provider, callsTo } = fakeProvider("github")
    const token = await connect(provider, "octo-builder")
    expect(token).toMatchObject({
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      scopes: [],
      obtainedAt: NOW,
    })
    const [exchange] = callsTo("/login/oauth/access_token")
    expect(exchange!.init.headers.Accept).toBe("application/json")
    expect(new URLSearchParams(exchange!.init.body).get("code_verifier")).toBeTruthy()

    // Never needs a refresh; refresh() is a no-op without calling GitHub.
    setClock(new Date(NOW.getTime() + 400 * 86_400_000))
    expect(tokenNeedsRefresh("github", token, new Date(NOW.getTime() + 400 * 86_400_000))).toBe(
      false,
    )
    const before = callsTo("/login/oauth/access_token").length
    expect(await provider.refresh(token)).toBe(token)
    expect(callsTo("/login/oauth/access_token")).toHaveLength(before)
    expect((await provider.fetchProfile(token)).username).toBe("octo-builder")
  })

  it("reports bad codes and wrong verifiers (sent with HTTP 200) as invalid_code", async () => {
    const { provider, callsTo } = fakeProvider("github")
    const code = mintFakeAuthorizationCode({
      provider: "github",
      account: "octo-builder",
      redirectUri: callbackUrl("github"),
      codeChallenge: pkceChallenge(createCodeVerifier()).codeChallenge,
    })
    for (const attempt of [
      provider.exchangeCode(code, { codeVerifier: createCodeVerifier() }),
      provider.exchangeCode("fkc_bogus.sig"),
    ]) {
      const error = await rejectionOf(attempt)
      expect((error as SocialProviderError).code).toBe("invalid_code")
    }
    // GitHub answers these with HTTP 200 and an `error` field.
    expect(callsTo("/login/oauth/access_token")).toHaveLength(2)
  })

  it("treats refused client credentials as our configuration error", async () => {
    const { provider } = fakeProvider("github", (url) =>
      url.pathname === "/login/oauth/access_token"
        ? jsonResponse(200, { error: "incorrect_client_credentials" })
        : undefined,
    )
    const error = await rejectionOf(provider.exchangeCode("x"))
    expect((error as SocialProviderError).code).toBe("provider_error")
  })

  it("refreshes expiring user tokens when the app opted into them", async () => {
    const { provider } = fakeProvider("github", (url) =>
      url.pathname === "/login/oauth/access_token"
        ? jsonResponse(200, {
            access_token: "ghu_new",
            expires_in: 28_800,
            refresh_token: "ghr_new",
            refresh_token_expires_in: 15_897_600,
            scope: "",
            token_type: "bearer",
          })
        : undefined,
    )
    const refreshed = await provider.refresh({
      accessToken: "ghu_old",
      refreshToken: "ghr_old",
      expiresAt: NOW,
      refreshExpiresAt: null,
      scopes: [],
      providerAccountId: "1",
    })
    expect(refreshed).toMatchObject({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: new Date(NOW.getTime() + 28_800_000),
      providerAccountId: "1",
    })
  })
})

describe("GitHub: profile and builder snapshot", () => {
  it("maps the profile", async () => {
    const { provider, callsTo } = fakeProvider("github")
    const profile = await provider.fetchProfile(await connect(provider, "octo-builder"))
    expect(profile).toMatchObject({
      providerAccountId: "9919001",
      username: "octo-builder",
      displayName: "Octo Builder",
      profileUrl: "https://github.com/octo-builder",
      followers: 312,
    })
    const [user] = callsTo("/user")
    expect(user!.init.headers["User-Agent"]).toBe("Vincera")
    expect(user!.init.headers.Accept).toBe("application/vnd.github+json")
  })

  it("maps stars, languages and contributions into a builder snapshot", async () => {
    const { provider, callsTo } = fakeProvider("github")
    const token = await connect(provider, "octo-builder")
    const snapshot = await provider.fetchAudience(token)

    expect(audienceSnapshotInputSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot).toMatchObject({
      followers: 312,
      avgViews: null,
      engagementRate: null,
      topCountries: [],
      countriesBasis: null,
      ageGender: null,
    })
    // Top languages by bytes, lowercase.
    expect(snapshot.topTopics).toEqual([
      "typescript",
      "python",
      "rust",
      "jupyter notebook",
      "css",
      "javascript",
      "shell",
      "lua",
    ])

    const stats = gitHubStatsFromRaw(snapshot.raw)
    expect(stats).not.toBeNull()
    expect(stats).toMatchObject({
      login: "octo-builder",
      publicRepos: 18,
      totalStars: 2_849,
      totalForks: 190,
      contributions: {
        from: "2025-10-05T12:00:00.000Z",
        to: "2026-10-05T12:00:00.000Z",
        total: 1_532,
        commits: 1_104,
        issues: 46,
        pullRequests: 212,
        reviews: 98,
        repositories: 7,
        restricted: 64,
      },
    })
    expect(stats!.topLanguages[0]).toEqual({ name: "TypeScript", bytes: 357_200, share: 0.5965 })
    expect(stats!.topRepos[0]).toMatchObject({ name: "invoice-cli", stars: 1_240 })
    expect(stats!.topRepos.length).toBeLessThanOrEqual(10)

    // One GraphQL call with the documented query and the 365-day window.
    const [graphql] = callsTo("/graphql")
    const body = JSON.parse(graphql!.init.body!) as { query: string; variables: object }
    expect(body.query).toBe(GITHUB_STATS_QUERY)
    expect(body.variables).toEqual({
      login: "octo-builder",
      from: "2025-10-05T12:00:00.000Z",
      to: "2026-10-05T12:00:00.000Z",
    })
    expect(JSON.stringify(snapshot)).not.toContain(token.accessToken)
  })

  it("handles an account without public repositories", async () => {
    const { provider } = fakeProvider("github")
    const snapshot = await provider.fetchAudience(await connect(provider, "new-dev"))
    expect(snapshot.followers).toBe(0)
    expect(snapshot.topTopics).toEqual([])
    const raw = githubRawSchema.parse(snapshot.raw)
    expect(raw).toMatchObject({ publicRepos: 0, totalStars: 0, topLanguages: [], topRepos: [] })
    expect(raw.contributions.total).toBe(3)
  })

  it("classifies rate limits, revoked tokens and GraphQL failures", async () => {
    let reply: Response | undefined
    const { provider } = fakeProvider("github", () => reply?.clone())
    const token = await connect(provider, "octo-builder")

    reply = jsonResponse(
      403,
      { message: "API rate limit exceeded" },
      { "x-ratelimit-remaining": "0" },
    )
    expect(await rejectionOf(provider.fetchProfile(token))).toBeInstanceOf(SocialRetryableError)

    reply = jsonResponse(403, { message: "You have exceeded a secondary rate limit." })
    expect(await rejectionOf(provider.fetchProfile(token))).toBeInstanceOf(SocialRetryableError)

    reply = jsonResponse(401, { message: "Bad credentials" })
    expect(await rejectionOf(provider.fetchProfile(token))).toBeInstanceOf(SocialTokenError)

    reply = undefined
    const { provider: graphqlLimited } = fakeProvider("github", (url) =>
      url.pathname === "/graphql"
        ? jsonResponse(200, { data: null, errors: [{ type: "RATE_LIMITED", message: "x" }] })
        : undefined,
    )
    const limited = await rejectionOf(
      graphqlLimited.fetchAudience(await connect(graphqlLimited, "octo-builder")),
    )
    expect((limited as SocialRetryableError).reason).toBe("rate_limited")

    const { provider: noUser } = fakeProvider("github", (url) =>
      url.pathname === "/graphql"
        ? jsonResponse(200, { data: { user: null }, errors: [{ type: "NOT_FOUND" }] })
        : undefined,
    )
    const missing = await rejectionOf(noUser.fetchAudience(await connect(noUser, "octo-builder")))
    expect((missing as SocialProviderError).code).toBe("provider_error")

    const { provider: malformed } = fakeProvider("github", (url) =>
      url.pathname === "/graphql"
        ? jsonResponse(200, { data: { user: { followers: { totalCount: -1 } } } })
        : undefined,
    )
    const invalid = await rejectionOf(
      malformed.fetchAudience(await connect(malformed, "octo-builder")),
    )
    expect((invalid as SocialProviderError).code).toBe("invalid_response")
  })
})

describe("gitHubStatsFromRaw", () => {
  it("returns null for anything that is not a v1 GitHub payload", () => {
    expect(gitHubStatsFromRaw(null)).toBeNull()
    expect(gitHubStatsFromRaw({ provider: "youtube", v: 1 })).toBeNull()
    expect(gitHubStatsFromRaw({ provider: "github", v: 2 })).toBeNull()
  })
})

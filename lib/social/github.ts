import "server-only"

import { z } from "zod"

import { now as clockNow } from "@/lib/clock"

import { SocialProviderError } from "./errors"
import {
  asCodeExchange,
  expiresIn,
  failure,
  parseResponse,
  requestJson,
  send,
  splitScopes,
  throwForStatus,
  type ErrorKind,
  type HttpClient,
  type HttpFailure,
  type HttpRequest,
  type ProviderConfig,
} from "./http"
import { cleanText, DAY_MS, safeUrl, sum, toCount, toShare } from "./metrics"
import { githubRawSchema, type GitHubRaw } from "./raw"
import {
  audienceSnapshotInputSchema,
  socialProfileSchema,
  type AudienceSnapshotInput,
  type SocialProfile,
  type SocialProvider,
  type TokenSet,
} from "./types"

/**
 * GitHub for builders (§7.1, CLAUDE.md §19.10, docs/integrations/social-providers.md): an OAuth
 * App that requests **no scope** (read-only public data), with PKCE S256. Uses the data-connection
 * credentials `GITHUB_DATA_CLIENT_ID` / `_SECRET`, separate from GitHub login.
 *
 * OAuth App tokens do not expire (no refresh token), unless the app opted into expiring tokens:
 * then the response carries `expires_in` + a rotating `refresh_token`, and `refresh()` uses it.
 *
 * Snapshot mapping (builders have no audience in the creator sense): `followers` = GitHub
 * followers, `top_topics` = top languages (lowercase), views/engagement/demographics null/empty.
 * Stars, repositories, languages and contribution counts are in `raw` (`gitHubStatsFromRaw`).
 */

export const GITHUB_ENDPOINTS = {
  authorize: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  user: "https://api.github.com/user",
  graphql: "https://api.github.com/graphql",
} as const

/** No scope: read-only access to public data (there are no read-only repo scopes). */
export const GITHUB_SCOPES = [] as const satisfies readonly string[]

const REST_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
}
const CONTRIBUTION_WINDOW_DAYS = 365
const TOP_LANGUAGES = 8
const TOP_REPOS = 10

export const GITHUB_STATS_QUERY = `
query ($login: String!, $from: DateTime, $to: DateTime) {
  user(login: $login) {
    followers { totalCount }
    repositories(
      first: 100
      ownerAffiliations: [OWNER]
      visibility: PUBLIC
      isFork: false
      orderBy: { field: STARGAZERS, direction: DESC }
    ) {
      totalCount
      nodes {
        name
        url
        stargazerCount
        forkCount
        isArchived
        pushedAt
        primaryLanguage { name }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          totalSize
          edges { size node { name } }
        }
      }
    }
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { totalContributions }
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalRepositoryContributions
      restrictedContributionsCount
    }
  }
}`.trim()

// --- Response schemas ---------------------------------------------------------------------------

const tokenSuccessSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  // Only when the app opted into expiring user tokens.
  expires_in: z.coerce.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.coerce.number().int().positive().optional(),
})
type TokenSuccess = z.infer<typeof tokenSuccessSchema>
/** The token endpoint answers errors with HTTP 200 and `{ error }`. */
const tokenErrorSchema = z.object({ error: z.string().min(1) })

const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable().optional(),
  avatar_url: z.string().optional(),
  html_url: z.string().optional(),
  bio: z.string().nullable().optional(),
  followers: z.number().int().nonnegative().optional(),
  public_repos: z.number().int().nonnegative().optional(),
})
type GitHubUser = z.infer<typeof userSchema>

const repoSchema = z.object({
  name: z.string(),
  url: z.string(),
  stargazerCount: z.number().int().nonnegative(),
  forkCount: z.number().int().nonnegative(),
  isArchived: z.boolean().optional(),
  pushedAt: z.string().nullable().optional(),
  primaryLanguage: z.object({ name: z.string() }).nullable().optional(),
  languages: z
    .object({
      edges: z
        .array(z.object({ size: z.number().nonnegative(), node: z.object({ name: z.string() }) }))
        .optional(),
    })
    .nullable()
    .optional(),
})

const statsResponseSchema = z.object({
  data: z
    .object({
      user: z
        .object({
          followers: z.object({ totalCount: z.number().int().nonnegative() }),
          repositories: z.object({
            totalCount: z.number().int().nonnegative(),
            // GraphQL lists may contain nulls (nodes the viewer cannot see).
            nodes: z.array(repoSchema.nullable()).optional(),
          }),
          contributionsCollection: z.object({
            contributionCalendar: z.object({ totalContributions: z.number().int().nonnegative() }),
            totalCommitContributions: z.number().int().nonnegative(),
            totalIssueContributions: z.number().int().nonnegative(),
            totalPullRequestContributions: z.number().int().nonnegative(),
            totalPullRequestReviewContributions: z.number().int().nonnegative(),
            totalRepositoryContributions: z.number().int().nonnegative(),
            restrictedContributionsCount: z.number().int().nonnegative(),
          }),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ type: z.string().optional() }).loose()).optional(),
})

// --- Helpers ------------------------------------------------------------------------------------

const apiErrorSchema = z.object({ message: z.string() })

function classifyGitHub(failure: HttpFailure): ErrorKind | undefined {
  const remaining = failure.headers.get("x-ratelimit-remaining")
  const parsed = apiErrorSchema.safeParse(failure.body)
  const message = parsed.success ? parsed.data.message : ""
  // Primary limit: 403/429 with x-ratelimit-remaining 0; secondary limits say so in the message.
  if ((failure.status === 403 || failure.status === 429) && remaining === "0") return "rate_limited"
  if ((failure.status === 403 || failure.status === 429) && /rate limit/i.test(message)) {
    return "rate_limited"
  }
  return undefined
}

function tokenErrorKind(code: string): ErrorKind {
  // bad_verification_code (exchange) and bad_refresh_token (refresh): the grant is unusable.
  if (code === "bad_verification_code" || code === "bad_refresh_token") return "token"
  return "fatal"
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

// --- Provider -----------------------------------------------------------------------------------

export function createGitHubProvider(config: ProviderConfig): SocialProvider {
  const now = config.now ?? clockNow
  const client: HttpClient = { provider: "github", fetch: config.fetch, classify: classifyGitHub }
  const headers = { ...REST_HEADERS, "User-Agent": config.userAgent ?? "creator-builder-platform" }

  async function tokenRequest(
    label: string,
    form: Record<string, string | undefined>,
  ): Promise<TokenSuccess> {
    const request: HttpRequest = {
      label,
      method: "POST",
      url: GITHUB_ENDPOINTS.token,
      form,
      headers: { Accept: "application/json", "User-Agent": headers["User-Agent"] },
    }
    const raw = await send(client, request)
    if (raw.status < 200 || raw.status > 299) throwForStatus(client, request, raw)
    const error = tokenErrorSchema.safeParse(raw.body)
    if (error.success && !tokenSuccessSchema.safeParse(raw.body).success) {
      throw failure(client, tokenErrorKind(error.data.error), label, raw.status)
    }
    return parseResponse(client, label, tokenSuccessSchema, raw.body)
  }

  function toTokenSet(response: TokenSuccess, previous: TokenSet | null): TokenSet {
    const at = now()
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? null,
      expiresAt: expiresIn(at, response.expires_in),
      refreshExpiresAt: expiresIn(at, response.refresh_token_expires_in),
      scopes: splitScopes(response.scope ?? previous?.scopes ?? []),
      providerAccountId: previous?.providerAccountId ?? null,
      obtainedAt: at,
    }
  }

  async function fetchUser(token: TokenSet): Promise<GitHubUser> {
    return requestJson(
      client,
      {
        label: "user",
        method: "GET",
        url: GITHUB_ENDPOINTS.user,
        bearer: token.accessToken,
        headers,
      },
      userSchema,
    )
  }

  return {
    id: "github",
    supportsPkce: true,
    scopes: GITHUB_SCOPES,

    authUrl(state, pkce) {
      const url = new URL(config.authorizeUrl ?? GITHUB_ENDPOINTS.authorize)
      url.searchParams.set("client_id", config.clientId)
      url.searchParams.set("redirect_uri", config.redirectUri)
      // No `scope` parameter: an empty scope list, i.e. public read-only data.
      url.searchParams.set("state", state)
      if (pkce) {
        url.searchParams.set("code_challenge", pkce.codeChallenge)
        url.searchParams.set("code_challenge_method", pkce.codeChallengeMethod)
      }
      return url.toString()
    },

    async exchangeCode(code, pkce) {
      const response = await asCodeExchange("github", () =>
        tokenRequest("oauth.token", {
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
          code_verifier: pkce?.codeVerifier,
        }),
      )
      return toTokenSet(response, null)
    },

    async refresh(token) {
      // Classic OAuth App tokens never expire and have nothing to refresh.
      if (!token.refreshToken) return token
      const response = await tokenRequest("oauth.refresh", {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      })
      return toTokenSet(response, token)
    },

    async fetchProfile(token): Promise<SocialProfile> {
      const user = await fetchUser(token)
      return parseResponse(client, "profile", socialProfileSchema, {
        providerAccountId: String(user.id),
        username: user.login,
        displayName: cleanText(user.name, 100),
        avatarUrl: safeUrl(user.avatar_url),
        profileUrl:
          safeUrl(user.html_url) ?? `https://github.com/${encodeURIComponent(user.login)}`,
        followers: toCount(user.followers),
        bio: cleanText(user.bio, 1000),
      })
    },

    async fetchAudience(token): Promise<AudienceSnapshotInput> {
      const user = await fetchUser(token)
      const to = now()
      const from = new Date(to.getTime() - CONTRIBUTION_WINDOW_DAYS * DAY_MS)
      const response = await requestJson(
        client,
        {
          label: "graphql.stats",
          method: "POST",
          url: GITHUB_ENDPOINTS.graphql,
          bearer: token.accessToken,
          headers,
          json: {
            query: GITHUB_STATS_QUERY,
            variables: { login: user.login, from: from.toISOString(), to: to.toISOString() },
          },
        },
        statsResponseSchema,
      )
      if (response.errors?.some((error) => error.type === "RATE_LIMITED")) {
        throw failure(client, "rate_limited", "graphql.stats", 200)
      }
      const stats = response.data?.user
      if (!stats) {
        throw new SocialProviderError("github", "provider_error", "github graphql.stats: no user")
      }

      const repos = (stats.repositories.nodes ?? []).filter((repo) => repo !== null)
      const bytesByLanguage = new Map<string, number>()
      for (const repo of repos) {
        for (const edge of repo.languages?.edges ?? []) {
          bytesByLanguage.set(
            edge.node.name,
            (bytesByLanguage.get(edge.node.name) ?? 0) + edge.size,
          )
        }
      }
      const totalBytes = sum([...bytesByLanguage.values()])
      const topLanguages = [...bytesByLanguage.entries()]
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .slice(0, TOP_LANGUAGES)
        .map(([name, bytes]) => ({
          name,
          bytes: toCount(bytes) ?? 0,
          share: toShare(bytes, totalBytes),
        }))

      const contributions = stats.contributionsCollection
      const raw = parseResponse(client, "raw", githubRawSchema, {
        provider: "github",
        v: 1,
        login: user.login,
        publicRepos: stats.repositories.totalCount,
        totalStars: toCount(sum(repos.map((repo) => repo.stargazerCount))) ?? 0,
        totalForks: toCount(sum(repos.map((repo) => repo.forkCount))) ?? 0,
        topLanguages,
        topRepos: [...repos]
          .sort((a, b) => b.stargazerCount - a.stargazerCount || a.name.localeCompare(b.name))
          .slice(0, TOP_REPOS)
          .map((repo) => ({
            name: repo.name,
            url: safeUrl(repo.url) ?? `https://github.com/${user.login}/${repo.name}`,
            stars: repo.stargazerCount,
            forks: repo.forkCount,
            language: repo.primaryLanguage?.name ?? null,
            pushedAt: toIso(repo.pushedAt),
            archived: repo.isArchived ?? false,
          })),
        contributions: {
          from: from.toISOString(),
          to: to.toISOString(),
          total: contributions.contributionCalendar.totalContributions,
          commits: contributions.totalCommitContributions,
          issues: contributions.totalIssueContributions,
          pullRequests: contributions.totalPullRequestContributions,
          reviews: contributions.totalPullRequestReviewContributions,
          repositories: contributions.totalRepositoryContributions,
          restricted: contributions.restrictedContributionsCount,
        },
      } satisfies GitHubRaw)

      return parseResponse(client, "audience", audienceSnapshotInputSchema, {
        followers: toCount(stats.followers.totalCount),
        avgViews: null,
        engagementRate: null,
        topCountries: [],
        countriesBasis: null,
        ageGender: null,
        topTopics: topLanguages.map((language) => language.name.toLowerCase()),
        raw,
      })
    },
  }
}

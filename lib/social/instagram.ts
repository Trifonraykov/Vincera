import "server-only"

import { z } from "zod"

import { now as clockNow } from "@/lib/clock"

import { SocialProviderError, SocialTokenError } from "./errors"
import {
  asCodeExchange,
  expiresIn,
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
import {
  averageCount,
  cleanText,
  DAY_MS,
  engagementRate,
  safeUrl,
  sum,
  toCount,
  toShare,
} from "./metrics"
import { instagramRawSchema, type InstagramRaw } from "./raw"
import { deriveTopics } from "./topics"
import {
  audienceSnapshotInputSchema,
  socialProfileSchema,
  type AudienceSnapshotInput,
  type SocialProfile,
  type SocialProvider,
  type TokenSet,
} from "./types"

/**
 * Instagram API with Instagram Login, Graph API v26.0 (§7.1, CLAUDE.md §19.10,
 * docs/integrations/social-providers.md). Business/Creator accounts only.
 *
 * Tokens: the code gives a 1-hour token, exchanged at once for a 60-day long-lived token. There
 * is no refresh token; `refresh()` calls `ig_refresh_token`, which only accepts tokens at least
 * 24 hours old that have not expired. Metrics use `views` (the deprecated `impressions`/`plays`
 * are gone). Follower demographics need ≥ 100 followers; their basis is `followers`.
 *
 * `META_APP_ID` / `META_APP_SECRET` hold the *Instagram* app ID and secret (App Dashboard →
 * Instagram → API setup with Instagram login), which differ from the Meta app's own ID.
 */

export const INSTAGRAM_GRAPH_VERSION = "v26.0"
export const INSTAGRAM_ENDPOINTS = {
  authorize: "https://www.instagram.com/oauth/authorize",
  shortLivedToken: "https://api.instagram.com/oauth/access_token",
  longLivedToken: "https://graph.instagram.com/access_token",
  refresh: "https://graph.instagram.com/refresh_access_token",
  graph: `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}`,
} as const

export const INSTAGRAM_BASIC_SCOPE = "instagram_business_basic"
export const INSTAGRAM_INSIGHTS_SCOPE = "instagram_business_manage_insights"
export const INSTAGRAM_SCOPES = [INSTAGRAM_BASIC_SCOPE, INSTAGRAM_INSIGHTS_SCOPE] as const

/** Follower demographics exist only from this many followers. */
export const INSTAGRAM_DEMOGRAPHICS_MIN_FOLLOWERS = 100
/** ig_refresh_token refuses tokens younger than this. */
export const INSTAGRAM_MIN_REFRESH_AGE_MS = DAY_MS
/** Long-lived token lifetime, used to estimate a token's age when it is unknown. */
export const INSTAGRAM_LONG_LIVED_MS = 60 * DAY_MS

const MEDIA_PAGE_SIZE = 25
/** Recent posts whose insights are read (one call each). */
export const INSTAGRAM_RECENT_MEDIA = 12
const INSIGHTS_CONCURRENCY = 4
const TOP_COUNTRIES = 10
const MEDIA_METRICS = "views,reach,likes,comments,shares,saved,total_interactions"

// --- Response schemas ---------------------------------------------------------------------------

/** Graph API ids are strings; a JSON number may have lost precision, so it is never trusted. */
const graphId = z.union([z.string().min(1), z.number()])

const shortTokenEntrySchema = z.object({
  access_token: z.string().min(1),
  user_id: graphId.optional(),
  permissions: z.union([z.string(), z.array(z.string())]).optional(),
})
/** Documented as `{ data: [entry] }`; a flat entry is accepted too (UNCONFIRMED in the brief). */
const shortTokenResponseSchema = z.union([
  z.object({ data: z.array(shortTokenEntrySchema).min(1) }),
  shortTokenEntrySchema,
])

const longTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().int().positive().optional(),
})

const graphErrorSchema = z.object({
  error: z
    .object({
      code: z.number().optional(),
      type: z.string().optional(),
      error_subtype: z.number().optional(),
      is_transient: z.boolean().optional(),
    })
    .loose(),
})
/** api.instagram.com/oauth/access_token errors. */
const oauthErrorSchema = z.object({
  error_type: z.string(),
  code: z.number().optional(),
})

const meSchema = z.object({
  id: z.string().min(1),
  user_id: graphId.optional(),
  username: z.string().optional(),
  name: z.string().optional(),
  account_type: z.string().optional(),
  profile_picture_url: z.string().optional(),
  followers_count: z.number().int().nonnegative().optional(),
  follows_count: z.number().int().nonnegative().optional(),
  media_count: z.number().int().nonnegative().optional(),
})
type Me = z.infer<typeof meSchema>

const mediaSchema = z.object({
  id: z.string().min(1),
  caption: z.string().optional(),
  media_type: z.string().optional(),
  media_product_type: z.string().optional(),
  timestamp: z.string().optional(),
  like_count: z.number().int().nonnegative().optional(),
  comments_count: z.number().int().nonnegative().optional(),
})
const mediaListSchema = z.object({ data: z.array(mediaSchema) })

const insightValuesSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      values: z.array(z.object({ value: z.number() }).loose()).optional(),
      total_value: z.object({ value: z.number() }).loose().optional(),
    }),
  ),
})

const demographicsSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      total_value: z
        .object({
          breakdowns: z
            .array(
              z.object({
                dimension_keys: z.array(z.string()).optional(),
                results: z
                  .array(
                    z.object({
                      dimension_values: z.array(z.string()),
                      value: z.number().nonnegative(),
                    }),
                  )
                  .optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
  ),
})

// --- Helpers ------------------------------------------------------------------------------------

/** Graph error codes: 190 = invalid/expired token; 4/17/32/613/800xx = rate limits. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002])

function classifyInstagram(failure: HttpFailure): ErrorKind | undefined {
  const graph = graphErrorSchema.safeParse(failure.body)
  if (graph.success) {
    const { code, is_transient } = graph.data.error
    if (code === 190) return "token"
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) return "rate_limited"
    if (code === 1 || code === 2 || is_transient) return "unavailable"
    // Our own app configuration (bad secret, app not approved) must not expire the connection.
    if (failure.status === 401) return "fatal"
    return undefined
  }
  const oauth = oauthErrorSchema.safeParse(failure.body)
  if (oauth.success && failure.status === 400) {
    // 101: our client secret was refused, which must not read as a bad code.
    if (oauth.data.code === 101) return "fatal"
    // The code endpoint answers 400 OAuthException for a bad, expired or reused code.
    return "token"
  }
  return undefined
}

function idString(value: string | number | undefined): string | null {
  return typeof value === "string" ? value : null
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  // Graph timestamps look like 2026-09-28T17:42:11+0000.
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

function metric(values: z.infer<typeof insightValuesSchema>, name: string): number | null {
  const entry = values.data.find((item) => item.name === name)
  const value = entry?.total_value?.value ?? entry?.values?.[0]?.value
  return value === undefined ? null : toCount(value)
}

function mapGender(value: string | undefined): "female" | "male" | "unknown" {
  if (value === "F") return "female"
  if (value === "M") return "male"
  return "unknown"
}

type MediaWithInsights = InstagramRaw["recentMedia"][number]

// --- Provider -----------------------------------------------------------------------------------

export function createInstagramProvider(config: ProviderConfig): SocialProvider {
  const now = config.now ?? clockNow
  const client: HttpClient = {
    provider: "instagram",
    fetch: config.fetch,
    classify: classifyInstagram,
  }
  const graph = (path: string) => `${INSTAGRAM_ENDPOINTS.graph}/${path}`
  // Graph API reads take the token as a query parameter (documented form). Errors never include
  // URLs, so it does not leak through them.
  const get = <S extends z.ZodType>(
    label: string,
    url: string,
    token: TokenSet,
    query: Record<string, string | number>,
    schema: S,
  ) =>
    requestJson(
      client,
      { label, method: "GET", url, query: { ...query, access_token: token.accessToken } },
      schema,
    )

  async function fetchMe(token: TokenSet): Promise<Me> {
    const me = await get(
      "me",
      graph("me"),
      token,
      {
        fields:
          "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count",
      },
      meSchema,
    )
    if (me.account_type?.toUpperCase() === "PERSONAL") {
      throw new SocialProviderError("instagram", "not_eligible", "instagram account is personal")
    }
    return me
  }

  /** The professional account id (`user_id`), which the media and insights edges use. */
  const accountId = (me: Me) => idString(me.user_id) ?? me.id

  function hasScope(token: TokenSet, scope: string): boolean {
    // An empty list means "unknown" (the long-lived exchange does not repeat permissions).
    return token.scopes.length === 0 || token.scopes.includes(scope)
  }

  async function mediaInsights(
    token: TokenSet,
    mediaId: string,
  ): Promise<z.infer<typeof insightValuesSchema> | null> {
    try {
      return await get(
        "media.insights",
        graph(`${encodeURIComponent(mediaId)}/insights`),
        token,
        { metric: MEDIA_METRICS },
        insightValuesSchema,
      )
    } catch (error) {
      // Some media types reject some metrics (#100); that post just has no insights.
      if (error instanceof SocialProviderError) return null
      throw error
    }
  }

  async function demographics(
    token: TokenSet,
    userId: string,
    breakdown: "country" | "age,gender",
  ): Promise<{ values: string[]; value: number }[]> {
    const response = await get(
      `insights.follower_demographics.${breakdown}`,
      graph(`${encodeURIComponent(userId)}/insights`),
      token,
      {
        metric: "follower_demographics",
        period: "lifetime",
        metric_type: "total_value",
        breakdown,
      },
      demographicsSchema,
    )
    const results = response.data[0]?.total_value?.breakdowns?.[0]?.results ?? []
    return results.map((result) => ({ values: result.dimension_values, value: result.value }))
  }

  async function exchangeLongLived(shortToken: string): Promise<{
    accessToken: string
    expiresIn: number | undefined
  }> {
    const response = await requestJson(
      client,
      {
        label: "oauth.long_lived",
        method: "GET",
        url: INSTAGRAM_ENDPOINTS.longLivedToken,
        query: {
          grant_type: "ig_exchange_token",
          client_secret: config.clientSecret,
          access_token: shortToken,
        },
      },
      longTokenResponseSchema,
    )
    return { accessToken: response.access_token, expiresIn: response.expires_in }
  }

  return {
    id: "instagram",
    supportsPkce: false,
    scopes: INSTAGRAM_SCOPES,

    authUrl(state) {
      const url = new URL(config.authorizeUrl ?? INSTAGRAM_ENDPOINTS.authorize)
      url.searchParams.set("client_id", config.clientId)
      url.searchParams.set("redirect_uri", config.redirectUri)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","))
      url.searchParams.set("state", state)
      return url.toString()
    },

    async exchangeCode(code) {
      return asCodeExchange("instagram", async () => {
        const request: HttpRequest = {
          label: "oauth.token",
          method: "POST",
          url: INSTAGRAM_ENDPOINTS.shortLivedToken,
          form: {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "authorization_code",
            redirect_uri: config.redirectUri,
            // Instagram appends `#_` to the redirect; a browser drops it, a copy-paste may not.
            code: code.replace(/#_$/, ""),
          },
        }
        const raw = await send(client, request)
        if (raw.status < 200 || raw.status > 299) throwForStatus(client, request, raw)
        const parsed = parseResponse(client, request.label, shortTokenResponseSchema, raw.body)
        const entry = "data" in parsed ? parsed.data[0]! : parsed
        const scopes = splitScopes(entry.permissions)
        if (scopes.length > 0 && !scopes.includes(INSTAGRAM_BASIC_SCOPE)) {
          throw new SocialProviderError("instagram", "scope_missing", "basic scope not granted")
        }

        const at = now()
        const longLived = await exchangeLongLived(entry.access_token)
        return {
          accessToken: longLived.accessToken,
          refreshToken: null,
          expiresAt: expiresIn(at, longLived.expiresIn),
          refreshExpiresAt: null,
          scopes,
          // The token's `user_id` is documented as the Instagram-scoped (app-scoped) id, while
          // the profile reports the professional account id (`/me` `user_id`), which the media
          // and insights edges take. The profile's id is the connection's identity, so the
          // token does not claim one that could disagree with it.
          providerAccountId: null,
          obtainedAt: at,
        } satisfies TokenSet
      })
    },

    async refresh(token) {
      const at = now()
      if (token.expiresAt && token.expiresAt.getTime() <= at.getTime()) {
        // Expired long-lived tokens cannot be refreshed; the user must reconnect.
        throw new SocialTokenError("instagram", "instagram token expired")
      }
      const obtainedAt =
        token.obtainedAt ??
        (token.expiresAt ? new Date(token.expiresAt.getTime() - INSTAGRAM_LONG_LIVED_MS) : null)
      if (obtainedAt && at.getTime() - obtainedAt.getTime() < INSTAGRAM_MIN_REFRESH_AGE_MS) {
        return token
      }
      const response = await requestJson(
        client,
        {
          label: "oauth.refresh",
          method: "GET",
          url: INSTAGRAM_ENDPOINTS.refresh,
          query: { grant_type: "ig_refresh_token", access_token: token.accessToken },
        },
        longTokenResponseSchema,
      )
      return {
        ...token,
        accessToken: response.access_token,
        expiresAt: expiresIn(at, response.expires_in),
        obtainedAt: at,
      }
    },

    async fetchProfile(token): Promise<SocialProfile> {
      const me = await fetchMe(token)
      return parseResponse(client, "profile", socialProfileSchema, {
        providerAccountId: accountId(me),
        username: me.username ?? null,
        displayName: cleanText(me.name, 100),
        avatarUrl: safeUrl(me.profile_picture_url),
        profileUrl: me.username
          ? `https://www.instagram.com/${encodeURIComponent(me.username)}/`
          : null,
        followers: toCount(me.followers_count),
        bio: null,
      })
    },

    async fetchAudience(token): Promise<AudienceSnapshotInput> {
      const me = await fetchMe(token)
      const userId = accountId(me)
      const followers = toCount(me.followers_count)
      const insightsGranted = hasScope(token, INSTAGRAM_INSIGHTS_SCOPE)

      const media = await get(
        "media",
        graph(`${encodeURIComponent(userId)}/media`),
        token,
        {
          fields:
            "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count",
          limit: MEDIA_PAGE_SIZE,
        },
        mediaListSchema,
      )
      const recent = media.data
        .filter((item) => item.media_product_type !== "STORY" && item.media_product_type !== "AD")
        .map((item) => ({ item, timestamp: toIso(item.timestamp) }))
        .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
        .slice(0, INSTAGRAM_RECENT_MEDIA)

      let failedMedia = 0
      const enriched: MediaWithInsights[] = []
      for (let i = 0; i < recent.length; i += INSIGHTS_CONCURRENCY) {
        const batch = recent.slice(i, i + INSIGHTS_CONCURRENCY)
        const insights = insightsGranted
          ? await Promise.all(batch.map(({ item }) => mediaInsights(token, item.id)))
          : batch.map(() => null)
        batch.forEach(({ item, timestamp }, j) => {
          const values = insights[j] ?? null
          if (insightsGranted && values === null) failedMedia += 1
          enriched.push({
            id: item.id,
            mediaType: item.media_type ?? null,
            productType: item.media_product_type ?? null,
            timestamp,
            caption: cleanText(item.caption, 150),
            likes: (values && metric(values, "likes")) ?? toCount(item.like_count),
            comments: (values && metric(values, "comments")) ?? toCount(item.comments_count),
            views: values && metric(values, "views"),
            reach: values && metric(values, "reach"),
            shares: values && metric(values, "shares"),
            saved: values && metric(values, "saved"),
          })
        })
      }

      // Demographics: counts of followers (top 45 countries), normalised to shares.
      let topCountries: AudienceSnapshotInput["topCountries"] = []
      let ageGender: AudienceSnapshotInput["ageGender"] = null
      let demographicsRaw: InstagramRaw["demographics"]
      if (!insightsGranted) {
        demographicsRaw = { available: false, reason: "scope_not_granted" }
      } else if ((followers ?? 0) < INSTAGRAM_DEMOGRAPHICS_MIN_FOLLOWERS) {
        demographicsRaw = { available: false, reason: "below_minimum" }
      } else {
        try {
          const [countries, ageGenderRows] = await Promise.all([
            demographics(token, userId, "country"),
            demographics(token, userId, "age,gender"),
          ])
          const countryRows = countries.flatMap(({ values, value }) => {
            const country = values[0]?.toUpperCase() ?? ""
            return /^[A-Z]{2}$/.test(country) && value > 0 ? [{ country, value }] : []
          })
          // Only the top 45 countries are listed, so divide by all followers when we know them.
          const countryTotal = Math.max(sum(countryRows.map((row) => row.value)), followers ?? 0)
          topCountries = countryRows
            .map((row) => ({ country: row.country, share: toShare(row.value, countryTotal) }))
            .sort((a, b) => b.share - a.share || a.country.localeCompare(b.country))
            .slice(0, TOP_COUNTRIES)

          const bucketRows = ageGenderRows.filter((row) => row.value > 0 && row.values[0])
          const bucketTotal = sum(bucketRows.map((row) => row.value))
          const buckets = bucketRows.map((row) => ({
            ageGroup: row.values[0]!.trim(),
            gender: mapGender(row.values[1]),
            share: toShare(row.value, bucketTotal),
          }))
          ageGender = buckets.length > 0 ? { basis: "followers", buckets } : null
          demographicsRaw = { available: true, totalFollowersCounted: toCount(bucketTotal) ?? 0 }
        } catch (error) {
          if (!(error instanceof SocialProviderError)) throw error
          demographicsRaw = { available: false, reason: "unavailable" }
        }
      }

      const raw = parseResponse(client, "raw", instagramRawSchema, {
        provider: "instagram",
        v: 1,
        account: {
          userId,
          username: me.username ?? null,
          accountType: me.account_type ?? null,
          followersCount: followers,
          followsCount: toCount(me.follows_count),
          mediaCount: toCount(me.media_count),
        },
        recentMedia: enriched,
        insights: { available: insightsGranted, failedMedia },
        demographics: demographicsRaw,
      } satisfies InstagramRaw)

      const withViews = enriched.filter((item) => item.views !== null)
      return parseResponse(client, "audience", audienceSnapshotInputSchema, {
        followers,
        avgViews: averageCount(withViews.map((item) => item.views ?? 0)),
        engagementRate: engagementRate(
          sum(
            withViews.map((item) => (item.likes ?? 0) + (item.comments ?? 0) + (item.shares ?? 0)),
          ),
          sum(withViews.map((item) => item.views ?? 0)),
        ),
        topCountries,
        countriesBasis: topCountries.length > 0 ? "followers" : null,
        ageGender,
        topTopics: deriveTopics(recent.map(({ item }) => ({ text: item.caption }))),
        raw,
      })
    },
  }
}

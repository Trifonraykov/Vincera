import "server-only"

import { z } from "zod"

import { now as clockNow } from "@/lib/clock"

import { SocialProviderError, SocialTokenError } from "./errors"
import {
  asCodeExchange,
  expiresIn,
  parseResponse,
  requestJson,
  splitScopes,
  type ErrorKind,
  type HttpClient,
  type HttpFailure,
  type ProviderConfig,
} from "./http"
import {
  averageCount,
  cleanText,
  DAY_MS,
  engagementRate,
  isoDurationSeconds,
  safeUrl,
  sum,
  toCount,
  toShare,
  utcDate,
} from "./metrics"
import { youtubeRawSchema, type YouTubeRaw } from "./raw"
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
 * YouTube Data API v3 + YouTube Analytics API v2 (§7.1, CLAUDE.md §19.10,
 * docs/integrations/social-providers.md).
 *
 * Quota per sync: channels.list (1) + playlistItems.list (1) + videos.list (1, ≤ 50 ids) and three
 * Analytics reports. `search.list` is never used (its 100 calls/day bucket would run out).
 * Demographics and countries are of *viewers* over the analytics window (basis `viewers`).
 */

export const YOUTUBE_ENDPOINTS = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  channels: "https://www.googleapis.com/youtube/v3/channels",
  playlistItems: "https://www.googleapis.com/youtube/v3/playlistItems",
  videos: "https://www.googleapis.com/youtube/v3/videos",
  reports: "https://youtubeanalytics.googleapis.com/v2/reports",
} as const

export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly"
export const YOUTUBE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly"
export const YOUTUBE_SCOPES = [YOUTUBE_READONLY_SCOPE, YOUTUBE_ANALYTICS_SCOPE] as const

/** Uploads fetched (one playlistItems page); videos.list takes ≤ 50 ids. */
const UPLOADS_PAGE_SIZE = 25
/** Videos avg_views and engagement_rate are computed over. */
export const YOUTUBE_RECENT_VIDEOS = 20
/** Videos younger than this are still gathering views; skipped when older ones exist. */
const FRESH_VIDEO_MS = 3 * DAY_MS
/** Analytics window: the 90 days ending yesterday (data lags by about a day). */
export const YOUTUBE_ANALYTICS_DAYS = 90
const TOP_COUNTRIES = 10

// --- Response schemas (strict where we depend on a field, tolerant elsewhere) --------------------

/** YouTube sends uint64 counts as strings. */
const count = z.coerce.number().int().nonnegative()

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  /** Present when the refresh token itself is time-limited (e.g. apps in Testing status: 7 days). */
  refresh_token_expires_in: z.coerce.number().int().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
})
type TokenResponse = z.infer<typeof tokenResponseSchema>

const googleErrorSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      code: z.number().optional(),
      status: z.string().optional(),
      errors: z.array(z.object({ reason: z.string().optional() }).loose()).optional(),
      details: z.array(z.object({ reason: z.string().optional() }).loose()).optional(),
    }),
  ]),
})

const channelSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      customUrl: z.string().optional(),
      publishedAt: z.string().optional(),
      country: z.string().optional(),
      thumbnails: z.record(z.string(), z.object({ url: z.string() }).loose()).optional(),
    })
    .optional(),
  statistics: z
    .object({
      viewCount: count.optional(),
      subscriberCount: count.optional(),
      hiddenSubscriberCount: z.boolean().optional(),
      videoCount: count.optional(),
    })
    .optional(),
  contentDetails: z
    .object({
      relatedPlaylists: z.object({ uploads: z.string().optional() }).loose().optional(),
    })
    .optional(),
})
type Channel = z.infer<typeof channelSchema>

const channelsResponseSchema = z.object({ items: z.array(channelSchema).optional() })

const playlistItemsResponseSchema = z.object({
  items: z
    .array(
      z.object({
        contentDetails: z.object({
          videoId: z.string().min(1),
          videoPublishedAt: z.string().optional(),
        }),
      }),
    )
    .optional(),
})

const videoSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: z.string().optional(),
      publishedAt: z.string().optional(),
      tags: z.array(z.string()).optional(),
      liveBroadcastContent: z.string().optional(),
    })
    .optional(),
  contentDetails: z.object({ duration: z.string().optional() }).optional(),
  statistics: z
    .object({
      viewCount: count.optional(),
      // Hidden by the owner on some videos.
      likeCount: count.optional(),
      // Absent when comments are disabled.
      commentCount: count.optional(),
    })
    .optional(),
})

const videosResponseSchema = z.object({ items: z.array(videoSchema).optional() })

/** Analytics `resultTable`: `rows` is omitted when there is no data; map cells by header name. */
const reportSchema = z.object({
  columnHeaders: z.array(z.object({ name: z.string().min(1) }).loose()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).optional(),
})
type Report = z.infer<typeof reportSchema>

// --- Helpers ------------------------------------------------------------------------------------

const RATE_LIMIT_REASONS = new Set([
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
])

function classifyGoogle(failure: HttpFailure): ErrorKind | undefined {
  const parsed = googleErrorSchema.safeParse(failure.body)
  if (!parsed.success) return undefined
  const { error } = parsed.data
  if (typeof error === "string") {
    // OAuth token endpoint: `invalid_grant` is a dead refresh token (or a bad code). Anything
    // else (`invalid_client`, `unauthorized_client`, ...) is our configuration, which must not
    // expire the user's connection.
    if (error === "invalid_grant") return "token"
    return failure.status >= 500 ? undefined : "fatal"
  }
  const reasons = [
    error.status,
    ...(error.errors ?? []).map((e) => e.reason),
    ...(error.details ?? []).map((d) => d.reason),
  ]
  if (reasons.some((reason) => reason !== undefined && RATE_LIMIT_REASONS.has(reason))) {
    return "rate_limited"
  }
  return undefined
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

function rows(report: Report): Record<string, string | number | null>[] {
  const names = report.columnHeaders.map((header) => header.name)
  return (report.rows ?? []).map((row) =>
    Object.fromEntries(names.map((name, i) => [name, row[i] ?? null])),
  )
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** `age18-24` → `18-24`, `age65-` → `65+`. */
export function normalizeYouTubeAgeGroup(value: string): string {
  const match = /^age(\d+)-(\d+)?$/.exec(value)
  if (!match) return value.replace(/^age/, "") || value
  return match[2] ? `${match[1]}-${match[2]}` : `${match[1]}+`
}

function mapGender(value: string): "female" | "male" | "other" | "unknown" {
  if (value === "female" || value === "male") return value
  if (value === "user_specified") return "other"
  return "unknown"
}

function avatarOf(channel: Channel): string | null {
  const thumbnails = channel.snippet?.thumbnails ?? {}
  return safeUrl(thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url)
}

type RecentVideo = YouTubeRaw["recentVideos"][number] & { tags: string[] }

// --- Provider -----------------------------------------------------------------------------------

export function createYouTubeProvider(config: ProviderConfig): SocialProvider {
  const now = config.now ?? clockNow
  const client: HttpClient = { provider: "youtube", fetch: config.fetch, classify: classifyGoogle }

  function toTokenSet(response: TokenResponse, previous: TokenSet | null): TokenSet {
    const at = now()
    const rotated = response.refresh_token !== undefined
    return {
      accessToken: response.access_token,
      // Refresh responses omit refresh_token: keep the one we have.
      refreshToken: response.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt: expiresIn(at, response.expires_in),
      refreshExpiresAt: rotated
        ? expiresIn(at, response.refresh_token_expires_in)
        : (previous?.refreshExpiresAt ?? null),
      scopes: response.scope ? splitScopes(response.scope) : (previous?.scopes ?? []),
      providerAccountId: previous?.providerAccountId ?? null,
      obtainedAt: at,
    }
  }

  async function fetchChannel(token: TokenSet): Promise<Channel> {
    const response = await requestJson(
      client,
      {
        label: "channels.list",
        method: "GET",
        url: YOUTUBE_ENDPOINTS.channels,
        query: { part: "snippet,statistics,contentDetails", mine: "true" },
        bearer: token.accessToken,
      },
      channelsResponseSchema,
    )
    const channel = response.items?.[0]
    if (!channel) {
      throw new SocialProviderError("youtube", "no_channel", "youtube account has no channel")
    }
    return channel
  }

  async function fetchRecentVideos(token: TokenSet, uploads: string): Promise<RecentVideo[]> {
    let playlist: z.infer<typeof playlistItemsResponseSchema>
    try {
      playlist = await requestJson(
        client,
        {
          label: "playlistItems.list",
          method: "GET",
          url: YOUTUBE_ENDPOINTS.playlistItems,
          query: { part: "contentDetails", playlistId: uploads, maxResults: UPLOADS_PAGE_SIZE },
          bearer: token.accessToken,
        },
        playlistItemsResponseSchema,
      )
    } catch (error) {
      // A channel without uploads has no uploads playlist (404 playlistNotFound).
      if (error instanceof SocialProviderError && error.status === 404) return []
      throw error
    }
    const ids = [...new Set((playlist.items ?? []).map((item) => item.contentDetails.videoId))]
    if (ids.length === 0) return []

    const response = await requestJson(
      client,
      {
        label: "videos.list",
        method: "GET",
        url: YOUTUBE_ENDPOINTS.videos,
        query: { part: "snippet,statistics,contentDetails", id: ids.slice(0, 50).join(",") },
        bearer: token.accessToken,
      },
      videosResponseSchema,
    )

    const videos = (response.items ?? [])
      .filter((video) => {
        const live = video.snippet?.liveBroadcastContent
        // Upcoming premieres and running streams have no meaningful view count yet.
        return live !== "upcoming" && live !== "live" && video.statistics?.viewCount !== undefined
      })
      .map((video): RecentVideo => ({
        id: video.id,
        title: cleanText(video.snippet?.title, 150),
        publishedAt: toIso(video.snippet?.publishedAt),
        durationSeconds: toCount(isoDurationSeconds(video.contentDetails?.duration)),
        views: toCount(video.statistics?.viewCount) ?? 0,
        likes: toCount(video.statistics?.likeCount),
        comments: toCount(video.statistics?.commentCount),
        tags: video.snippet?.tags ?? [],
      }))
      .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))

    const cutoff = now().getTime() - FRESH_VIDEO_MS
    const settled = videos.filter(
      (video) => video.publishedAt === null || Date.parse(video.publishedAt) <= cutoff,
    )
    return (settled.length > 0 ? settled : videos).slice(0, YOUTUBE_RECENT_VIDEOS)
  }

  type Analytics = {
    raw: YouTubeRaw["analytics"]
    topCountries: AudienceSnapshotInput["topCountries"]
    ageGender: AudienceSnapshotInput["ageGender"]
  }

  async function fetchAnalytics(token: TokenSet): Promise<Analytics> {
    // An empty list means the token response did not say; try, and let a 403 decide.
    if (token.scopes.length > 0 && !token.scopes.includes(YOUTUBE_ANALYTICS_SCOPE)) {
      return {
        raw: { available: false, reason: "scope_not_granted" },
        topCountries: [],
        ageGender: null,
      }
    }
    const end = new Date(now().getTime() - DAY_MS)
    const startDate = utcDate(new Date(end.getTime() - (YOUTUBE_ANALYTICS_DAYS - 1) * DAY_MS))
    const endDate = utcDate(end)
    const report = (label: string, query: Record<string, string | number>) =>
      requestJson(
        client,
        {
          label,
          method: "GET",
          url: YOUTUBE_ENDPOINTS.reports,
          query: { ids: "channel==MINE", startDate, endDate, ...query },
          bearer: token.accessToken,
        },
        reportSchema,
      )

    let totalsReport: Report, countriesReport: Report, demographicsReport: Report
    try {
      ;[totalsReport, countriesReport, demographicsReport] = await Promise.all([
        report("reports.totals", {
          metrics:
            "views,engagedViews,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost",
        }),
        report("reports.countries", {
          dimensions: "country",
          metrics: "views",
          sort: "-views",
          maxResults: TOP_COUNTRIES,
        }),
        report("reports.demographics", {
          dimensions: "ageGroup,gender",
          metrics: "viewerPercentage",
          sort: "gender,ageGroup",
        }),
      ])
    } catch (error) {
      // Not every channel may use Analytics (e.g. the scope was refused): keep the Data API part.
      if (error instanceof SocialProviderError && error.status === 403) {
        return { raw: { available: false, reason: "forbidden" }, topCountries: [], ageGender: null }
      }
      throw error
    }

    const totalsRow = rows(totalsReport)[0] ?? {}
    const total = (name: string) => toCount(num(totalsRow[name]))
    const totals = {
      views: total("views"),
      engagedViews: total("engagedViews"),
      estimatedMinutesWatched: total("estimatedMinutesWatched"),
      averageViewDuration: total("averageViewDuration"),
      likes: total("likes"),
      comments: total("comments"),
      shares: total("shares"),
      subscribersGained: total("subscribersGained"),
      subscribersLost: total("subscribersLost"),
    }

    const countryRows = rows(countriesReport).flatMap((row) => {
      const country = typeof row.country === "string" ? row.country.toUpperCase() : ""
      const views = num(row.views)
      // `ZZ` is YouTube's "unknown region".
      return /^[A-Z]{2}$/.test(country) && country !== "ZZ" && views !== null && views > 0
        ? [{ country, views }]
        : []
    })
    const countryDenominator =
      totals.views && totals.views > 0 ? totals.views : sum(countryRows.map((row) => row.views))
    const topCountries = countryRows
      .map((row) => ({ country: row.country, share: toShare(row.views, countryDenominator) }))
      .sort((a, b) => b.share - a.share || a.country.localeCompare(b.country))
      .slice(0, TOP_COUNTRIES)

    const buckets = rows(demographicsReport).flatMap((row) => {
      const percentage = num(row.viewerPercentage)
      if (typeof row.ageGroup !== "string" || typeof row.gender !== "string") return []
      if (percentage === null || percentage <= 0) return []
      return [
        {
          ageGroup: normalizeYouTubeAgeGroup(row.ageGroup),
          gender: mapGender(row.gender),
          share: toShare(percentage, 100),
        },
      ]
    })

    return {
      raw: { available: true, startDate, endDate, totals },
      topCountries,
      ageGender: buckets.length > 0 ? { basis: "viewers", buckets } : null,
    }
  }

  return {
    id: "youtube",
    supportsPkce: true,
    scopes: YOUTUBE_SCOPES,

    authUrl(state, pkce) {
      const url = new URL(config.authorizeUrl ?? YOUTUBE_ENDPOINTS.authorize)
      url.searchParams.set("client_id", config.clientId)
      url.searchParams.set("redirect_uri", config.redirectUri)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "))
      // Offline access + consent: Google only issues a refresh token this way.
      url.searchParams.set("access_type", "offline")
      url.searchParams.set("prompt", "consent")
      url.searchParams.set("include_granted_scopes", "true")
      url.searchParams.set("state", state)
      if (pkce) {
        url.searchParams.set("code_challenge", pkce.codeChallenge)
        url.searchParams.set("code_challenge_method", pkce.codeChallengeMethod)
      }
      return url.toString()
    },

    async exchangeCode(code, pkce) {
      const response = await asCodeExchange("youtube", () =>
        requestJson(
          client,
          {
            label: "oauth.token",
            method: "POST",
            url: YOUTUBE_ENDPOINTS.token,
            form: {
              grant_type: "authorization_code",
              code,
              client_id: config.clientId,
              client_secret: config.clientSecret,
              redirect_uri: config.redirectUri,
              code_verifier: pkce?.codeVerifier,
            },
          },
          tokenResponseSchema,
        ),
      )
      const token = toTokenSet(response, null)
      // Users can untick scopes on Google's consent screen. Without youtube.readonly there is
      // nothing to read; without analytics the sync falls back to Data API numbers.
      if (token.scopes.length > 0 && !token.scopes.includes(YOUTUBE_READONLY_SCOPE)) {
        throw new SocialProviderError("youtube", "scope_missing", "youtube.readonly not granted")
      }
      return token
    },

    async refresh(token) {
      if (!token.refreshToken) {
        throw new SocialTokenError("youtube", "youtube token has no refresh token")
      }
      const response = await requestJson(
        client,
        {
          label: "oauth.refresh",
          method: "POST",
          url: YOUTUBE_ENDPOINTS.token,
          form: {
            grant_type: "refresh_token",
            refresh_token: token.refreshToken,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          },
        },
        tokenResponseSchema,
      )
      return toTokenSet(response, token)
    },

    async fetchProfile(token): Promise<SocialProfile> {
      const channel = await fetchChannel(token)
      const customUrl = channel.snippet?.customUrl ?? null
      const stats = channel.statistics
      return parseResponse(client, "profile", socialProfileSchema, {
        providerAccountId: channel.id,
        username: customUrl,
        displayName: cleanText(channel.snippet?.title, 100),
        avatarUrl: avatarOf(channel),
        profileUrl: customUrl
          ? `https://www.youtube.com/${encodeURIComponent(customUrl).replace(/^%40/, "@")}`
          : `https://www.youtube.com/channel/${encodeURIComponent(channel.id)}`,
        followers: stats?.hiddenSubscriberCount ? null : toCount(stats?.subscriberCount),
        bio: cleanText(channel.snippet?.description, 1000),
      })
    },

    async fetchAudience(token): Promise<AudienceSnapshotInput> {
      const channel = await fetchChannel(token)
      const stats = channel.statistics
      const uploads = channel.contentDetails?.relatedPlaylists?.uploads
      const videos =
        uploads && stats?.videoCount !== 0 ? await fetchRecentVideos(token, uploads) : []
      const analytics = await fetchAnalytics(token)

      const hidden = stats?.hiddenSubscriberCount === true
      const raw = parseResponse(client, "raw", youtubeRawSchema, {
        provider: "youtube",
        v: 1,
        channel: {
          id: channel.id,
          title: cleanText(channel.snippet?.title, 100),
          customUrl: channel.snippet?.customUrl ?? null,
          country: channel.snippet?.country ?? null,
          publishedAt: toIso(channel.snippet?.publishedAt),
          subscriberCount: hidden ? null : toCount(stats?.subscriberCount),
          hiddenSubscriberCount: hidden,
          viewCount: toCount(stats?.viewCount),
          videoCount: toCount(stats?.videoCount),
        },
        recentVideos: videos.map(({ tags: _tags, ...video }) => video),
        analytics: analytics.raw,
      } satisfies YouTubeRaw)

      return parseResponse(client, "audience", audienceSnapshotInputSchema, {
        followers: raw.channel.subscriberCount,
        avgViews: averageCount(videos.map((video) => video.views)),
        engagementRate: engagementRate(
          sum(videos.map((video) => (video.likes ?? 0) + (video.comments ?? 0))),
          sum(videos.map((video) => video.views)),
        ),
        topCountries: analytics.topCountries,
        countriesBasis: analytics.topCountries.length > 0 ? "viewers" : null,
        ageGender: analytics.ageGender,
        topTopics: deriveTopics(videos.map((video) => ({ text: video.title, tags: video.tags }))),
        raw,
      })
    },
  }
}

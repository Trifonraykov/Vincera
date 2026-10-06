import "server-only"

import { z } from "zod"

import { now as clockNow } from "@/lib/clock"

import { SocialProviderError, SocialTokenError } from "./errors"
import {
  asCodeExchange,
  expiresIn,
  failure,
  parseResponse,
  send,
  splitScopes,
  throwForStatus,
  type ErrorKind,
  type HttpClient,
  type HttpFailure,
  type HttpRequest,
  type ProviderConfig,
} from "./http"
import { averageCount, cleanText, engagementRate, safeUrl, sum, toCount } from "./metrics"
import { tiktokRawSchema, type TikTokRaw } from "./raw"
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
 * TikTok Login Kit + Display API v2 (§7.1, CLAUDE.md §19.10,
 * docs/integrations/social-providers.md).
 *
 * No PKCE on the web flow. Access tokens last 24h, refresh tokens 365 days and **rotate**: every
 * refresh returns a new refresh token, which must replace the stored one. No demographics are
 * available (`ageGender = null`, `topCountries = []`). Fields are requested per granted scope, so
 * a user who unticks `user.info.stats` still connects (followers unknown).
 */

export const TIKTOK_ENDPOINTS = {
  authorize: "https://www.tiktok.com/v2/auth/authorize/",
  token: "https://open.tiktokapis.com/v2/oauth/token/",
  userInfo: "https://open.tiktokapis.com/v2/user/info/",
  videoList: "https://open.tiktokapis.com/v2/video/list/",
} as const

export const TIKTOK_SCOPES = [
  "user.info.basic",
  "user.info.profile",
  "user.info.stats",
  "video.list",
] as const

/** Display API maximum page size. */
export const TIKTOK_MAX_VIDEOS = 20

const FIELDS_BY_SCOPE = {
  "user.info.basic": ["open_id", "union_id", "avatar_url", "display_name"],
  "user.info.profile": ["username", "bio_description", "is_verified"],
  "user.info.stats": ["follower_count", "following_count", "likes_count", "video_count"],
} as const

const VIDEO_FIELDS =
  "id,title,video_description,create_time,cover_image_url,share_url,duration,like_count,comment_count,share_count,view_count"

// --- Response schemas ---------------------------------------------------------------------------

const tokenSuccessSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive().optional(),
  open_id: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_expires_in: z.coerce.number().int().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
})
type TokenSuccess = z.infer<typeof tokenSuccessSchema>
const tokenErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
})

/** The `{ data, error: { code: "ok" } }` envelope of every Display API response. */
const envelopeErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() }).loose(),
})

const count = z.number().int().nonnegative()
const userInfoSchema = z.object({
  data: z.object({
    user: z.object({
      open_id: z.string().min(1),
      union_id: z.string().optional(),
      avatar_url: z.string().optional(),
      display_name: z.string().optional(),
      username: z.string().optional(),
      bio_description: z.string().optional(),
      is_verified: z.boolean().optional(),
      follower_count: count.optional(),
      following_count: count.optional(),
      likes_count: count.optional(),
      video_count: count.optional(),
    }),
  }),
})
type TikTokUser = z.infer<typeof userInfoSchema>["data"]["user"]

const videoListSchema = z.object({
  data: z.object({
    videos: z
      .array(
        z.object({
          id: z.string().min(1),
          title: z.string().optional(),
          video_description: z.string().optional(),
          create_time: z.number().int().optional(),
          duration: z.number().optional(),
          like_count: count.optional(),
          comment_count: count.optional(),
          share_count: count.optional(),
          view_count: count.optional(),
        }),
      )
      .optional(),
    cursor: z.number().optional(),
    has_more: z.boolean().optional(),
  }),
})

// --- Helpers ------------------------------------------------------------------------------------

const ENVELOPE_KINDS: Record<string, ErrorKind> = {
  access_token_invalid: "token",
  rate_limit_exceeded: "rate_limited",
  internal_error: "unavailable",
}

/** Display API errors (`error.code`). */
function classifyTikTok(failure: HttpFailure): ErrorKind | undefined {
  const parsed = envelopeErrorSchema.safeParse(failure.body)
  if (!parsed.success) return undefined
  return ENVELOPE_KINDS[parsed.data.error.code] ?? (failure.status === 401 ? "fatal" : undefined)
}

/** OAuth endpoint errors (`{ error, error_description }`). */
function tokenErrorKind(code: string, status: number): ErrorKind {
  if (code === "rate_limit_exceeded") return "rate_limited"
  if (code === "server_error" || code === "temporarily_unavailable" || status >= 500) {
    return "unavailable"
  }
  // The code or refresh token is unusable (expired, revoked, already used).
  if (code === "invalid_grant" || code === "access_denied") return "token"
  // invalid_client, unauthorized_client, invalid_request, ...: our configuration or request,
  // never a reason to expire the user's connection.
  return "fatal"
}

// --- Provider -----------------------------------------------------------------------------------

export function createTikTokProvider(config: ProviderConfig): SocialProvider {
  const now = config.now ?? clockNow
  const client: HttpClient = { provider: "tiktok", fetch: config.fetch, classify: classifyTikTok }

  /** POST the token endpoint; errors may arrive with a 200 status, so check the body first. */
  async function tokenRequest(
    label: string,
    form: Record<string, string | undefined>,
  ): Promise<TokenSuccess> {
    const request: HttpRequest = { label, method: "POST", url: TIKTOK_ENDPOINTS.token, form }
    const raw = await send(client, request)
    const error = tokenErrorSchema.safeParse(raw.body)
    if (error.success && !tokenSuccessSchema.safeParse(raw.body).success) {
      throw failure(client, tokenErrorKind(error.data.error, raw.status), label, raw.status)
    }
    if (raw.status < 200 || raw.status > 299) throwForStatus(client, request, raw)
    return parseResponse(client, label, tokenSuccessSchema, raw.body)
  }

  function toTokenSet(response: TokenSuccess, previous: TokenSet | null): TokenSet {
    const at = now()
    return {
      accessToken: response.access_token,
      // Rotation: the response's refresh token replaces the old one.
      refreshToken: response.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt: expiresIn(at, response.expires_in),
      refreshExpiresAt: response.refresh_token
        ? expiresIn(at, response.refresh_expires_in)
        : (previous?.refreshExpiresAt ?? null),
      scopes: response.scope ? splitScopes(response.scope) : (previous?.scopes ?? []),
      providerAccountId: response.open_id ?? previous?.providerAccountId ?? null,
      obtainedAt: at,
    }
  }

  /** Display API calls: non-2xx statuses and non-`ok` envelopes both become errors. */
  async function api<S extends z.ZodType>(request: HttpRequest, schema: S): Promise<z.output<S>> {
    const raw = await send(client, request)
    if (raw.status < 200 || raw.status > 299) throwForStatus(client, request, raw)
    const envelope = envelopeErrorSchema.safeParse(raw.body)
    if (envelope.success && envelope.data.error.code !== "ok") {
      const kind = ENVELOPE_KINDS[envelope.data.error.code] ?? "fatal"
      if (envelope.data.error.code === "scope_not_authorized") {
        throw new SocialProviderError("tiktok", "scope_missing", `tiktok ${request.label}: scope`)
      }
      throw failure(client, kind, request.label, raw.status)
    }
    return parseResponse(client, request.label, schema, raw.body)
  }

  function granted(token: TokenSet, scope: string): boolean {
    return token.scopes.length === 0 || token.scopes.includes(scope)
  }

  async function fetchUser(token: TokenSet): Promise<TikTokUser> {
    const fields = Object.entries(FIELDS_BY_SCOPE).flatMap(([scope, list]) =>
      scope === "user.info.basic" || granted(token, scope) ? [...list] : [],
    )
    const response = await api(
      {
        label: "user.info",
        method: "GET",
        url: TIKTOK_ENDPOINTS.userInfo,
        query: { fields: fields.join(",") },
        bearer: token.accessToken,
      },
      userInfoSchema,
    )
    return response.data.user
  }

  return {
    id: "tiktok",
    supportsPkce: false,
    scopes: TIKTOK_SCOPES,

    authUrl(state) {
      const url = new URL(config.authorizeUrl ?? TIKTOK_ENDPOINTS.authorize)
      url.searchParams.set("client_key", config.clientId)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("scope", TIKTOK_SCOPES.join(","))
      url.searchParams.set("redirect_uri", config.redirectUri)
      url.searchParams.set("state", state)
      return url.toString()
    },

    async exchangeCode(code) {
      const response = await asCodeExchange("tiktok", () =>
        tokenRequest("oauth.token", {
          client_key: config.clientId,
          client_secret: config.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: config.redirectUri,
        }),
      )
      const token = toTokenSet(response, null)
      if (token.scopes.length > 0 && !token.scopes.includes("user.info.basic")) {
        throw new SocialProviderError("tiktok", "scope_missing", "user.info.basic not granted")
      }
      return token
    },

    async refresh(token) {
      const at = now()
      if (!token.refreshToken) throw new SocialTokenError("tiktok", "tiktok has no refresh token")
      if (token.refreshExpiresAt && token.refreshExpiresAt.getTime() <= at.getTime()) {
        throw new SocialTokenError("tiktok", "tiktok refresh token expired")
      }
      const response = await tokenRequest("oauth.refresh", {
        client_key: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      })
      return toTokenSet(response, token)
    },

    async fetchProfile(token): Promise<SocialProfile> {
      const user = await fetchUser(token)
      return parseResponse(client, "profile", socialProfileSchema, {
        providerAccountId: user.open_id,
        username: user.username ?? null,
        displayName: cleanText(user.display_name, 100),
        avatarUrl: safeUrl(user.avatar_url),
        profileUrl: user.username
          ? `https://www.tiktok.com/@${encodeURIComponent(user.username)}`
          : null,
        followers: toCount(user.follower_count),
        bio: cleanText(user.bio_description, 1000),
      })
    },

    async fetchAudience(token): Promise<AudienceSnapshotInput> {
      const user = await fetchUser(token)
      const missingScopes = TIKTOK_SCOPES.filter((scope) => !granted(token, scope))
      const videos = granted(token, "video.list")
        ? ((
            await api(
              {
                label: "video.list",
                method: "POST",
                url: TIKTOK_ENDPOINTS.videoList,
                query: { fields: VIDEO_FIELDS },
                json: { max_count: TIKTOK_MAX_VIDEOS },
                bearer: token.accessToken,
              },
              videoListSchema,
            )
          ).data.videos ?? [])
        : []

      const recent: TikTokRaw["recentVideos"] = videos
        .map((video) => ({
          id: video.id,
          title: cleanText(video.title ?? video.video_description, 150),
          createdAt:
            video.create_time !== undefined
              ? new Date(video.create_time * 1000).toISOString()
              : null,
          durationSeconds: toCount(video.duration),
          views: toCount(video.view_count),
          likes: toCount(video.like_count),
          comments: toCount(video.comment_count),
          shares: toCount(video.share_count),
        }))
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        .slice(0, TIKTOK_MAX_VIDEOS)

      const raw = parseResponse(client, "raw", tiktokRawSchema, {
        provider: "tiktok",
        v: 1,
        user: {
          openId: user.open_id,
          username: user.username ?? null,
          displayName: cleanText(user.display_name, 100),
          isVerified: user.is_verified ?? null,
          followerCount: toCount(user.follower_count),
          followingCount: toCount(user.following_count),
          likesCount: toCount(user.likes_count),
          videoCount: toCount(user.video_count),
        },
        recentVideos: recent,
        missingScopes,
      } satisfies TikTokRaw)

      const withViews = recent.filter((video) => video.views !== null)
      return parseResponse(client, "audience", audienceSnapshotInputSchema, {
        followers: toCount(user.follower_count),
        avgViews: averageCount(withViews.map((video) => video.views ?? 0)),
        engagementRate: engagementRate(
          sum(
            withViews.map(
              (video) => (video.likes ?? 0) + (video.comments ?? 0) + (video.shares ?? 0),
            ),
          ),
          sum(withViews.map((video) => video.views ?? 0)),
        ),
        // The Display API has no audience demographics (§19.10).
        topCountries: [],
        countriesBasis: null,
        ageGender: null,
        topTopics: deriveTopics(
          videos.map((video) => ({
            text: [video.title, video.video_description].filter(Boolean).join(" "),
          })),
        ),
        raw,
      })
    },
  }
}

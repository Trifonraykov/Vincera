# Social providers — implementation brief (researched 2026-10-05)

Source tags: **[V]** verified from an official machine-readable source (Google discovery docs, GitHub docs repo / OpenAPI / GraphQL schema, Meta business SDK v26); **[S]** official doc page seen via search excerpt; **UNCONFIRMED** = test before relying on it. Implementation goes in `lib/social/{youtube,instagram,tiktok,github}.ts` behind the `SocialProvider` interface (§7.1).

## Differences from CLAUDE.md §7.1 (decisions in §19)

1. **YouTube subscriberCount is rounded** (3 significant figures above 1,000) and can be hidden (`hiddenSubscriberCount`). [S]
2. **YouTube "age/gender" is viewer demographics** (`viewerPercentage` of views by signed-in viewers in a date range), not subscriber demographics. Top countries are by views. `ageGroup` includes `age13-17` since 2026-03. [S]
3. **YouTube views changed meaning** (2025-03-31): Shorts `views` count every play; `engagedViews` keeps the old method. Store both. [S]
4. **YouTube policy**:
   - Brand verification plus sensitive-scope verification (about 10 business days). [S]
   - **While the app is in Testing status, refresh tokens expire after 7 days**, with a cap of 100 test users. [S]
   - Delete data within 30 days of revocation or once the token can't be refreshed. [S]
   - **Keeping statistics longer than 30 days needs acceptance under the derived-metrics/data-storage policy** (allows up to 36 months), plus re-checking authorization every 30 days. [S]
   - Quota: 10,000 units/day; `search.list` has its own bucket of 100 calls/day, so don't use it. [S]
5. **Instagram scopes are `instagram_business_basic` and `instagram_business_manage_insights`**. The old `business_*` values were deprecated on 2025-01-27. [S]
6. **Instagram has no refresh token**:
   - Short-lived token (1h) → `ig_exchange_token` gives a long-lived token (60d).
   - `ig_refresh_token` refreshes it; the token must be ≥24h old and not expired. [S]
7. **Instagram metric renames** (2025-04-21): `impressions`, `plays`, `clips_replays_count` and `ig_reels_aggregated_all_plays_count` are gone. Use `views`. [S]
8. **Instagram demographics**:
   - Use `follower_demographics` / `engaged_audience_demographics` with `breakdown` = age, gender, country or city.
   - Needs ≥100 followers. Returns top 45 only, up to 48h delay. [S]
   - Engaged `timeframe` accepts `this_week` / `this_month` only. (UNCONFIRMED)
9. **Instagram needs App Review + Business Verification** for Advanced Access. [S]
10. **Instagram rate limit** = 4,800 × the account's impressions in the last 24h, per app–user pair. [S]
11. **TikTok demographics are unavailable** in Login Kit / Display API. They exist only in the TikTok API for Business, which is out of MVP scope. [S]
12. **TikTok stats need `user.info.stats`; `username` needs `user.info.profile`.** Every scope needs review. Public videos only; no reach, impressions or watch time. [S]
13. **TikTok sandbox** allows end-to-end testing with up to 10 target users before review. [S]
14. **GitHub "read-only scopes" don't exist.** `public_repo` and `repo` are read/write. **Request no scope** → read-only public data. [V]
15. **Token shapes differ** (see table), so `TokenSet` needs nullable `refreshToken`, `expiresAt` and `refreshExpiresAt`:

    | Provider         | Refresh token                                                      | Lifetimes                |
    | ---------------- | ------------------------------------------------------------------ | ------------------------ |
    | Google           | Yes, only with `access_type=offline` (`prompt=consent` forces one) | —                        |
    | TikTok           | **Rotates** — always store the new one                             | Access 24h, refresh 365d |
    | Instagram        | None; refresh the access token itself                              | 60d                      |
    | GitHub OAuth App | None by default (non-expiring)                                     | —                        |

16. **Meta Graph API v20 expired 2026-09-24.** Pin v25.0 or v26.0. v21 expires 2027-01-21. [S]

## YouTube (Data API v3 + Analytics API v2)

**OAuth**

- Authorize: `https://accounts.google.com/o/oauth2/v2/auth`. Token: `https://oauth2.googleapis.com/token`. Revoke: `https://oauth2.googleapis.com/revoke`. [V]
- Authorize params: `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-separated), `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, `state`, `code_challenge` + `code_challenge_method=S256` (PKCE supported). [V/S]
- Token response: `access_token`, `expires_in`, `refresh_token?`, `scope`, `token_type`.
  - Users can untick scopes on the consent screen, so check `scope`. [S]
- Refresh: `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`.
- Redirect URI: exact match, HTTPS (localhost exempt), no wildcards or fragments.

**Scopes:** `https://www.googleapis.com/auth/youtube.readonly` and `https://www.googleapis.com/auth/yt-analytics.readonly`. Do **not** request `yt-analytics-monetary.readonly`.

**Endpoints**

- Base: `https://www.googleapis.com/youtube/v3/` (also `youtube.googleapis.com`).
- `GET channels?part=snippet,statistics,contentDetails&mine=true` (1 unit). Response is `items[0]` [V]:
  - `id`
  - `snippet.{title, customUrl?, thumbnails.{default,medium,high}.url, country?, publishedAt}`
  - `statistics.{subscriberCount, viewCount, videoCount}` (uint64 **strings**), `statistics.hiddenSubscriberCount`
  - `contentDetails.relatedPlaylists.uploads`
  - Empty `items` means the account has no channel.
- `GET playlistItems?part=contentDetails&playlistId={uploads}&maxResults=50`: returns `items[].contentDetails.{videoId, videoPublishedAt}` and `nextPageToken`.
- `GET videos?part=snippet,statistics,contentDetails&id=a,b,…` (≤50 ids): returns `items[].{id, snippet.{title,publishedAt,thumbnails}, contentDetails.duration (ISO 8601), statistics.{viewCount, likeCount?, commentCount?}}` (strings).

**Analytics:** `GET https://youtubeanalytics.googleapis.com/v2/reports`

- Required on every call: `ids=channel==MINE`, `startDate`, `endDate` (YYYY-MM-DD).
- Totals: `metrics=views,engagedViews,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost`.
- Countries: `dimensions=country&metrics=views&sort=-views&maxResults=10`. ISO alpha-2; `ZZ` = unknown.
- Demographics: `dimensions=ageGroup,gender&metrics=viewerPercentage&sort=gender,ageGroup`.
  - `ageGroup` ∈ `age13-17 … age65-`; `gender` ∈ `female|male|user_specified`.
- Response: `columnHeaders[].{name,columnType,dataType}` and `rows?: unknown[][]`.
  - **`rows` is omitted when there is no data.** Map columns by header name.

**Quota:** about 3 units per sync, against 10,000 units/day.

## Instagram (API with Instagram Login), host `https://graph.instagram.com/v26.0`

**OAuth**

- Authorize: `https://www.instagram.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope=instagram_business_basic,instagram_business_manage_insights&state`
  - The code lasts 1h and can be used once.
  - Strip a trailing `#_` (UNCONFIRMED). No PKCE.
- Short-lived token: `POST https://api.instagram.com/oauth/access_token`, form-encoded, with `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code`.
  - Response: `{data:[{access_token,user_id,permissions}]}`. Also accept a flat object (UNCONFIRMED).
- Long-lived token: `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret&access_token` → `{access_token, token_type, expires_in}`.
- Refresh: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token`.
- Account eligibility: Business/Creator accounts only.

**Endpoints**

- Profile: `GET /me?fields=user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count`
- Media: `GET /{ig-user-id}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,like_count,comments_count`
  - Paging via `paging.cursors.after` / `paging.next`.
  - `media_type` ∈ `IMAGE|VIDEO|CAROUSEL_ALBUM`; `media_product_type` ∈ `AD|FEED|STORY|REELS`.
- Media insights: `GET /{media-id}/insights?metric=views,reach,likes,comments,shares,saved,total_interactions`
  - Response: `data[].{name, period, values:[{value}]}`.
  - Tolerate per-metric "invalid metric" errors.
- Account insights: `GET /{ig-user-id}/insights?metric=reach,views,accounts_engaged,total_interactions&period=day&metric_type=total_value&since&until` → `data[].total_value.value`. (UNCONFIRMED list)
- Demographics: `GET /{ig-user-id}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=country|age|gender|city`
  - Response: `data[0].total_value.breakdowns[0].results[].{dimension_values[], value}`. Values are counts; normalise them. (UNCONFIRMED shape)

**Rate limit:** see the `X-Business-Use-Case-Usage` header.

## TikTok (Login Kit + Display API)

**OAuth**

- Authorize: `https://www.tiktok.com/v2/auth/authorize/?client_key&response_type=code&scope=user.info.basic,user.info.profile,user.info.stats,video.list&redirect_uri&state` (scope is comma-separated).
- Token: `POST https://open.tiktokapis.com/v2/oauth/token/` (form) with `client_key`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`.
  - Response: `{access_token, expires_in, open_id, refresh_token, refresh_expires_in, scope, token_type}`.
- Refresh: same endpoint, `grant_type=refresh_token`. **Store the new refresh token.**
- PKCE is not used on web.
- Redirect URI: static `https://`, no query, ≤10 URIs.

**Endpoints**

- Profile: `GET https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username,bio_description,is_verified,follower_count,following_count,likes_count,video_count`
  - Envelope: `{data:{user}, error:{code:"ok",message,log_id}}`.
- Videos: `POST https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,duration,like_count,comment_count,share_count,view_count`
  - Body: `{max_count:20, cursor}`.
  - Response: `data.{videos[],cursor,has_more}`.
  - `cover_image_url` expires after 6h.

**Rate limit:** 600 requests/min per endpoint; 429 `rate_limit_exceeded`.

## GitHub (OAuth App, **no scope** = read-only public data)

**OAuth**

- Authorize: `https://github.com/login/oauth/authorize?client_id&redirect_uri&scope=&state&code_challenge&code_challenge_method=S256` (PKCE recommended, S256 only).
- Token: `POST https://github.com/login/oauth/access_token` with `Accept: application/json`, `client_id`, `client_secret`, `code`, `redirect_uri`, `code_verifier` → `{access_token, scope, token_type}`.
  - The code expires after 10 min.
  - Tokens are non-expiring unless expiring tokens are enabled.

**Endpoints**

- REST: `GET https://api.github.com/user` → `{id, login, name, avatar_url, html_url, bio, followers, following, public_repos, created_at}`.
- GraphQL `POST https://api.github.com/graphql` (one call):
  ```graphql
  query ($login: String!, $from: DateTime, $to: DateTime) {
    user(login: $login) {
      followers {
        totalCount
      }
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
          primaryLanguage {
            name
          }
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            totalSize
            edges {
              size
              node {
                name
              }
            }
          }
        }
      }
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
        }
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalRepositoryContributions
        restrictedContributionsCount
      }
    }
  }
  ```
- Total stars = sum of `stargazerCount` over owned, non-fork repos.

**Rate limits:** REST 5,000/h per user; GraphQL 5,000 points/h.

## Zod notes

- YouTube counts are strings: use `z.coerce.number()`.
- Make optional fields optional, including Analytics `rows`.
- TikTok: check `error.code === "ok"`.
- `AudienceSnapshotInput` should record the basis of the demographics (`viewer_pct` for YouTube vs `follower_count` for Instagram). Their numbers mean different things.

import "server-only"

import { isBotUserAgent } from "@/lib/attribution/bots"
import { ATTRIBUTION_COOKIE } from "@/lib/attribution/cookie"
import { requestCountry, userAgentHash } from "@/lib/attribution/request-context"
import { resolveCheckoutAttribution } from "@/lib/attribution/resolve"
import type { DbOrTx } from "@/lib/db/client"
import { track } from "@/lib/events/track"
import { clientIp, rateLimit } from "@/lib/ratelimit"

import { findPublicLaunchId } from "./queries"

/**
 * `POST /p/<slug>/view` (CLAUDE.md §19.31: `product_page.viewed` from a `navigator.sendBeacon`):
 * the static product page cannot record a view itself, so a small script posts here once per
 * browser session. Anonymous (actor null), rate limited per IP with the `redirect` bucket, bots
 * skipped. The tracked link is resolved like the checkout's (`resolveCheckoutAttribution`): the
 * `attr` cookie's enabled link of this launch, else the page's `?ref=` forwarded by the beacon
 * (CLAUDE.md §19.37). No IP is stored.
 * Always answers 204 (nothing for a script to act on).
 */
export async function recordProductPageView(
  request: Request,
  slug: string,
  deps: { db: DbOrTx },
): Promise<Response> {
  const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })
  if (!/^[a-z0-9-]{3,80}$/.test(slug)) return done()
  const userAgent = request.headers.get("user-agent")
  if (isBotUserAgent(userAgent)) return done()
  const limit = await rateLimit("redirect", clientIp(request.headers))
  if (!limit.success) return done()
  const launchId = await findPublicLaunchId(deps.db, slug)
  if (!launchId) return done()

  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ATTRIBUTION_COOKIE}=`))
    ?.slice(ATTRIBUTION_COOKIE.length + 1)
  // The same rule as the checkout (cookie first, then `?ref=`), so the per-link funnel agrees.
  const { trackedLinkId } = await resolveCheckoutAttribution(deps.db, {
    launchId,
    cookie,
    ref: new URL(request.url).searchParams.get("ref"),
  })
  await track(
    "product_page.viewed",
    {
      actorUserId: null,
      subjectType: "launch",
      subjectId: launchId,
      properties: { tracked_link_id: trackedLinkId },
      context: { ip_country: requestCountry(request.headers), ua_hash: userAgentHash(userAgent) },
    },
    deps.db,
  )
  return done()
}

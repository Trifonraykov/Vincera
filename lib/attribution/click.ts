import "server-only"

import { randomBytes } from "node:crypto"

import { eq } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import { withTransaction } from "@/lib/db/client"
import { launches, linkClicks, trackedLinks } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import { now } from "@/lib/clock"
import { isPublicLaunch } from "@/lib/launches/status"
import { clientIp, rateLimit } from "@/lib/ratelimit"
import { absoluteUrl } from "@/lib/urls"

import { isBotUserAgent } from "./bots"
import {
  ATTRIBUTION_COOKIE,
  cookieOptions,
  parseVisitorCookie,
  REF_PARAM,
  TRACKED_LINK_CODE_PATTERN,
  VISITOR_COOKIE,
} from "./cookie"
import { referrerOrigin, requestCountry, userAgentHash } from "./request-context"

/**
 * `GET /r/<code>` (§10; CLAUDE.md §19.31 "Attribution", §19.32): log the click, set the
 * attribution cookie (last click wins) and send the visitor to the product page.
 *
 * - Unknown codes, and links of launches that are not public, answer a plain 404 page.
 * - A disabled link still redirects (old posts keep working) but logs nothing and sets no cookie:
 *   it stopped attributing (§5 `tracked_links.disabled_at`).
 * - Bots (lib/attribution/bots.ts) are logged with `is_bot` and get no cookies.
 * - Over the `redirect` rate limit (§14) the visitor is still redirected, without a log row.
 * - `link_clicks` keeps the referrer's origin, the country header, a keyed hash of the user agent
 *   and the `vid` cookie (issued once); never the IP. `link.clicked { is_bot }` is the event.
 * - The redirect carries `?ref=<code>` (the checkout's fallback when cookies are blocked) and,
 *   when the link has a discount code, `?code=<CODE>` to apply it.
 */

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link not found</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100svh;display:grid;place-items:center;padding:16px;background:#fff;color:#0a0a0a}@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}a{color:#fafafa}}main{max-width:28rem;text-align:center}h1{font-size:1.25rem}</style></head><body><main><h1>This link doesn't work</h1><p>The product it pointed to isn't available. Check the link, or ask whoever shared it for a new one.</p><p><a href="/">Go to the home page</a></p></main></body></html>`

function notFound(): Response {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  })
}

export function newVisitorId(): string {
  return randomBytes(16).toString("base64url")
}

type CookieWrite = { name: string; value: string }

function serializeCookie(cookie: CookieWrite, secure: boolean): string {
  const options = cookieOptions(secure)
  return [
    `${cookie.name}=${cookie.value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return null
}

export type ClickOutcome = "logged" | "bot" | "disabled" | "rate_limited"

export async function handleTrackedLinkRequest(
  request: Request,
  code: string,
  deps: { db: DbOrTx },
): Promise<Response> {
  if (!TRACKED_LINK_CODE_PATTERN.test(code)) return notFound()
  const [link] = await deps.db
    .select({
      id: trackedLinks.id,
      launchId: trackedLinks.launchId,
      code: trackedLinks.code,
      discountCode: trackedLinks.discountCode,
      disabledAt: trackedLinks.disabledAt,
      slug: launches.slug,
      status: launches.status,
      wentLiveAt: launches.wentLiveAt,
    })
    .from(trackedLinks)
    .innerJoin(launches, eq(launches.id, trackedLinks.launchId))
    .where(eq(trackedLinks.code, code))
  if (!link || !isPublicLaunch(link)) {
    return notFound()
  }

  const target = new URL(absoluteUrl(`/p/${link.slug}`))
  const secure = target.protocol === "https:"
  const headers = new Headers({
    "Cache-Control": "no-store, private",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
  })
  // `outcome` documents why a branch redirects; only the database tells them apart.
  const redirect = (_outcome: ClickOutcome) => {
    headers.set("Location", target.toString())
    return new Response(null, { status: 302, headers })
  }

  if (link.disabledAt) return redirect("disabled")
  target.searchParams.set(REF_PARAM, link.code)
  if (link.discountCode) target.searchParams.set("code", link.discountCode)

  const userAgent = request.headers.get("user-agent")
  const isBot = isBotUserAgent(userAgent)
  const cookieHeader = request.headers.get("cookie")
  let visitorId = parseVisitorCookie(readCookie(cookieHeader, VISITOR_COOKIE))
  if (!isBot) {
    if (!visitorId) {
      visitorId = newVisitorId()
      headers.append(
        "Set-Cookie",
        serializeCookie({ name: VISITOR_COOKIE, value: visitorId }, secure),
      )
    }
    // Last click wins (§10): every click of a person replaces the cookie.
    headers.append(
      "Set-Cookie",
      serializeCookie({ name: ATTRIBUTION_COOKIE, value: link.id }, secure),
    )
  }

  const limit = await rateLimit("redirect", clientIp(request.headers))
  if (!limit.success) return redirect("rate_limited")

  const country = requestCountry(request.headers)
  const uaHash = userAgentHash(userAgent)
  const clickedAt = now()
  await withTransaction(async (tx) => {
    await tx.insert(linkClicks).values({
      trackedLinkId: link.id,
      clickedAt,
      referrer: referrerOrigin(request.headers),
      country,
      uaHash,
      visitorId: isBot ? null : visitorId,
      isBot,
    })
    await track(
      "link.clicked",
      {
        actorUserId: null,
        subjectType: "tracked_link",
        subjectId: link.id,
        properties: { launch_id: link.launchId, is_bot: isBot },
        context: { ip_country: country, ua_hash: uaHash },
        occurredAt: clickedAt,
      },
      tx,
    )
  }, deps.db)
  return redirect(isBot ? "bot" : "logged")
}

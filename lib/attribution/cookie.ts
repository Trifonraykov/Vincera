import { z } from "zod"

/**
 * Attribution cookies (§10; CLAUDE.md §19.31). Pure: no `next/headers`, so the `/r/[code]` route,
 * the checkout route and tests share it. Owner: the launch builder (who writes `/r/[code]`); the
 * checkout builder reads it.
 *
 * - `attr=<tracked_link_id>` (a UUID, nothing else): set by `/r/[code]` on every click, so the last
 *   click wins; 30 days.
 * - `vid=<random id>`: an anonymous visitor id for `link_clicks.visitor_id` (dedupes clicks per
 *   browser), 30 days. Never tied to a person.
 *
 * Both are httpOnly, SameSite=Lax (they must survive the top-level navigation from Instagram or
 * YouTube), Secure on https, path `/`. A cookie that does not parse is ignored, and the checkout
 * only uses a link of the same launch that is not disabled.
 */

export const ATTRIBUTION_COOKIE = "attr"
export const VISITOR_COOKIE = "vid"
export const ATTRIBUTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** `?ref=<code>` on `/p/[slug]` (the fallback when the cookie is missing): a tracked link code. */
export const REF_PARAM = "ref"
/** `?code=<discount code>` on `/p/[slug]`: a promotion code to apply up front. */
export const DISCOUNT_PARAM = "code"

export const TRACKED_LINK_CODE_PATTERN = /^[0-9A-Za-z]{8}$/
export const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

const linkId = z.uuid()

export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
  }
}

/** The tracked link id in an `attr` cookie, or null when absent or malformed. */
export function parseAttributionCookie(value: string | null | undefined): string | null {
  const parsed = linkId.safeParse(value)
  return parsed.success ? parsed.data.toLowerCase() : null
}

/** A `?ref=` value that can be a tracked link code, or null. */
export function parseRefParam(value: string | null | undefined): string | null {
  return value && TRACKED_LINK_CODE_PATTERN.test(value) ? value : null
}

/** A `vid` cookie value we issued (16 random bytes, base64url), or null. */
export function parseVisitorCookie(value: string | null | undefined): string | null {
  return value && VISITOR_ID_PATTERN.test(value) ? value : null
}

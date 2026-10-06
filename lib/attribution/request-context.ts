import "server-only"

import { createHmac } from "node:crypto"

import { env } from "@/lib/env"

/**
 * What `/r/[code]` and the product-page beacon keep about a request (§10, §11 context): the
 * visitor's country from the hosting platform's header, the referrer's origin only (never its
 * path or query, which can carry personal data), and a keyed hash of the user agent. The IP itself
 * is never stored.
 */

/** Country headers set by Vercel and Cloudflare (ISO 3166-1 alpha-2). */
const COUNTRY_HEADERS = ["x-vercel-ip-country", "cf-ipcountry"] as const

export function requestCountry(headers: Headers): string | null {
  for (const name of COUNTRY_HEADERS) {
    const value = headers.get(name)?.trim().toUpperCase()
    // XX = unknown, T1 = Tor (Cloudflare).
    if (value && /^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "T1") return value
  }
  return null
}

/** The referrer's origin (`https://www.youtube.com`), or null for none or a non-web one. */
export function referrerOrigin(headers: Headers): string | null {
  const referrer = headers.get("referer")
  if (!referrer) return null
  try {
    const url = new URL(referrer)
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin.slice(0, 200) : null
  } catch {
    return null
  }
}

function uaKey(): Buffer {
  return createHmac("sha256", env.AUTH_SECRET).update("vincera/ua-hash/v1").digest()
}

/** HMAC-SHA256 of the user agent (32 hex characters), or null without one. */
export function userAgentHash(userAgent: string | null | undefined): string | null {
  const ua = userAgent?.trim()
  if (!ua) return null
  return createHmac("sha256", uaKey()).update(ua.slice(0, 1000)).digest("hex").slice(0, 32)
}

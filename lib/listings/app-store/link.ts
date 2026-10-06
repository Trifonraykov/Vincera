/**
 * What a builder may paste to connect an App Store developer account (CLAUDE.md §19.45).
 * Client-safe and pure, so the form can check it before submitting.
 *
 * - a developer link: `https://apps.apple.com/us/developer/<slug>/id<digits>`;
 * - an app link: `https://apps.apple.com/us/app/<slug>/id<digits>` (the server looks the app up
 *   and uses its developer, `artistId`);
 * - a bare id: `1234567890` or `id1234567890` (a developer id).
 *
 * `itunes.apple.com` links are accepted too (older links). The storefront in the link (`/us/`) is
 * returned when present.
 */

export type AppStoreInput = {
  kind: "developer" | "app"
  id: string
  /** Lower-case ISO 3166-1 alpha-2 storefront from the link, if any. */
  country: string | null
}

const STORE_HOSTS = new Set(["apps.apple.com", "itunes.apple.com"])
const ID = /^(?:id)?(\d{1,20})$/i

export const APP_STORE_INPUT_MESSAGE =
  "Paste your App Store developer link (apps.apple.com/…/developer/…/id…), an app link, or your developer id."

export function parseAppStoreInput(raw: string): AppStoreInput | null {
  const value = raw.trim()
  if (value === "") return null
  const bare = ID.exec(value)
  if (bare?.[1]) return { kind: "developer", id: bare[1], country: null }

  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (!STORE_HOSTS.has(url.hostname.toLowerCase())) return null

  const segments = url.pathname.split("/").filter(Boolean)
  let country: string | null = null
  if (segments[0] && /^[a-z]{2}$/i.test(segments[0])) country = segments.shift()!.toLowerCase()
  const kindIndex = segments.findIndex((s) => s === "developer" || s === "app" || s === "artist")
  if (kindIndex < 0) return null
  const kind = segments[kindIndex] === "app" ? "app" : "developer"
  const idSegment = segments.slice(kindIndex + 1).find((s) => /^id\d{1,20}$/i.test(s))
  const id = idSegment ? ID.exec(idSegment)?.[1] : undefined
  if (!id) return null
  return { kind, id, country }
}

/** Storefronts are two letters; anything else falls back to the US store. */
export function storefront(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const value = (candidate ?? "").trim().toLowerCase()
    if (/^[a-z]{2}$/.test(value)) return value
  }
  return "us"
}

/** Apple's public developer page for an artist id. */
export function developerPageUrl(developerId: string, country: string): string {
  return `https://apps.apple.com/${country}/developer/id${developerId}`
}

import {
  cleanLine,
  cleanParagraphs,
  cleanTitle,
  LISTING_DESCRIPTION_MAX,
  safeLink,
  topicsFrom,
} from "../text"
import type { ListingDraft, RemoteImage } from "../types"
import { idString, isAppleImageHost, type AppStoreApp } from "./lookup"

/**
 * One App Store app → a product listing (CLAUDE.md §19.45). Format `app`, stage `live` (it is in
 * the store), topics from Apple's genres (the shared topic rules; "Games" stays a topic), the store
 * page as the demo link, the icon plus up to five screenshots (iPhone first, iPad when the app has
 * no iPhone screenshots). Prices: Apple's label is kept for display; the matching price (euros,
 * §19.25) only when the storefront's currency is EUR.
 */

export const MAX_SCREENSHOTS = 5

function appleImage(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    return isAppleImageHost(parsed.hostname) ? parsed.href : null
  } catch {
    return null
  }
}

/** Plain-language fallback when an app has no description (publishing needs one, §19.25). */
function fallbackDescription(app: AppStoreApp): string {
  const genre = cleanLine(app.primaryGenreName, 60)
  return `${cleanTitle(app.trackName) ?? "This app"} is ${genre ? `a ${genre.toLowerCase()} app` : "an app"} on the App Store by ${cleanLine(app.artistName, 120) ?? "its developer"}.`
}

export function appToDraft(app: AppStoreApp, country: string): ListingDraft {
  const trackId = idString(app.trackId)
  const title = cleanTitle(app.trackName) ?? `App ${trackId}`
  const description =
    cleanParagraphs(app.description, LISTING_DESCRIPTION_MAX) ?? fallbackDescription(app)
  const genres = (app.genres ?? []).map((g) => cleanLine(g, 60)).filter((g): g is string => !!g)
  const primary = cleanLine(app.primaryGenreName, 60)
  const topics = topicsFrom([primary, ...genres])
  const currency = app.currency ? app.currency.toLowerCase() : null
  const price = typeof app.price === "number" ? app.price : null
  const storeUrl = safeLink(app.trackViewUrl)

  const images: RemoteImage[] = []
  const icon = appleImage(app.artworkUrl512) ?? appleImage(app.artworkUrl100)
  if (icon) images.push({ kind: "icon", url: icon })
  const iphone = (app.screenshotUrls ?? []).map(appleImage).filter((u): u is string => !!u)
  const ipad = (app.ipadScreenshotUrls ?? []).map(appleImage).filter((u): u is string => !!u)
  for (const url of (iphone.length > 0 ? iphone : ipad).slice(0, MAX_SCREENSHOTS)) {
    images.push({ kind: "screenshot", url })
  }

  return {
    source: "app_store",
    sourceId: trackId,
    sourceUrl: storeUrl,
    title,
    description,
    format: "app",
    stage: "live",
    topics: topics.length > 0 ? topics : ["apps"],
    targetPriceCents: currency === "eur" && price !== null ? Math.round(price * 100) : null,
    demoUrl: storeUrl,
    meta: {
      kind: "app_store",
      trackId,
      artistId: idString(app.artistId),
      artistName: cleanLine(app.artistName, 120) ?? "",
      sellerName: cleanLine(app.sellerName, 120),
      country,
      priceLabel: cleanLine(app.formattedPrice, 30),
      price,
      currency,
      rating: typeof app.averageUserRating === "number" ? app.averageUserRating : null,
      ratingCount: typeof app.userRatingCount === "number" ? app.userRatingCount : null,
      genre: primary,
      genres,
      releaseDate: cleanLine(app.releaseDate, 40),
      currentVersionReleaseDate: cleanLine(app.currentVersionReleaseDate, 40),
    },
    images,
  }
}

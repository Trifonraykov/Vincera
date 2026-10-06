import type { ProductFormat } from "@/lib/db/schema"

import {
  cleanLine,
  cleanParagraphs,
  cleanTitle,
  displayDomain,
  LISTING_DESCRIPTION_MAX,
  safeLink,
  topicsFrom,
} from "../text"
import type { ListingDraft, RemoteImage } from "../types"
import type { ParsedPage } from "./parse"

/**
 * A read web page → a product listing (CLAUDE.md §19.45). The listing is keyed by the link the
 * builder pasted, normalised (`listingKeyForUrl`), so pasting it again updates the same listing.
 */

const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|igshid)$/i

/** The listing key of a link: lower-case host, no fragment, no tracking parameters. */
export function listingKeyForUrl(url: URL): string {
  const copy = new URL(url.href)
  copy.hash = ""
  copy.hostname = copy.hostname.toLowerCase()
  for (const name of [...copy.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(name)) copy.searchParams.delete(name)
  }
  if (copy.pathname !== "/" && copy.pathname.endsWith("/"))
    copy.pathname = copy.pathname.replace(/\/+$/, "")
  return copy.href.slice(0, 500)
}

function formatOf(page: ParsedPage, finalUrl: URL): ProductFormat {
  if (page.structured.type === "product") return "other"
  const category = (page.structured.category ?? "").toLowerCase()
  if (
    /game|mobile/.test(category) ||
    /apps\.apple\.com|play\.google\.com/.test(finalUrl.hostname)
  ) {
    return "app"
  }
  if (/template|notion/.test(`${page.title ?? ""} ${category}`.toLowerCase())) return "template"
  return "tool"
}

/** "BusinessApplication" → "business"; "Productivity" → "productivity". */
function categoryTopic(category: string | null): string | null {
  if (!category) return null
  const words = category
    .replace(/Application$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
  return words === "" ? null : words
}

function priceLabel(price: number | null, currency: string | null): string | null {
  if (price === null) return null
  if (price === 0) return "Free"
  if (!currency) return null
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price)
  } catch {
    return null
  }
}

export function pageToDraft(input: {
  page: ParsedPage
  /** The link the builder pasted (already checked by safeFetch). */
  requestedUrl: URL
  /** Where the redirects ended. */
  finalUrl: URL
}): ListingDraft {
  const { page, finalUrl } = input
  const domain = displayDomain(finalUrl)
  const title =
    cleanTitle(page.title) ?? cleanTitle(page.siteName) ?? cleanTitle(domain) ?? "Untitled product"
  const candidates = [page.description, page.structured.description]
    .map((d) => cleanParagraphs(d, LISTING_DESCRIPTION_MAX))
    .filter((d): d is string => !!d)
  const description = candidates.sort((a, b) => b.length - a.length)[0] ?? `${title}, on ${domain}.`
  const category = categoryTopic(page.structured.category)
  const topics = topicsFrom([category, ...page.structured.keywords, ...page.keywords])
  const currency = page.structured.priceCurrency?.toLowerCase() ?? null
  const price = page.structured.price

  const images: RemoteImage[] = []
  const icon = page.icons[0]
  if (icon) images.push({ kind: "icon", url: icon })
  const image = page.images[0]
  if (image) images.push({ kind: "image", url: image })

  const link =
    safeLink(
      page.canonical && displayDomain(page.canonical) === domain ? page.canonical : finalUrl.href,
    ) ?? safeLink(finalUrl.href)

  return {
    source: "web",
    sourceId: listingKeyForUrl(input.requestedUrl),
    sourceUrl: link,
    title,
    description,
    format: formatOf(page, finalUrl),
    stage: "live",
    topics: topics.length > 0 ? topics : ["web"],
    targetPriceCents: currency === "eur" && price !== null ? Math.round(price * 100) : null,
    demoUrl: link,
    meta: {
      kind: "web",
      domain,
      siteName: cleanLine(page.siteName, 80),
      finalUrl: safeLink(finalUrl.href) ?? `https://${domain}/`,
      priceLabel: priceLabel(price, page.structured.priceCurrency),
      rating: page.structured.rating,
      ratingCount: page.structured.ratingCount,
      category: cleanLine(category, 60),
    },
    images,
  }
}

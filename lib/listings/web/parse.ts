import { Parser } from "htmlparser2"
import { z } from "zod"

/**
 * Read a product page (CLAUDE.md §19.45): Open Graph, Twitter cards, `<title>`, the meta
 * description and keywords, JSON-LD (`SoftwareApplication` and its subtypes, `Product`), the
 * canonical link, and the icons (`apple-touch-icon` preferred, then `icon`).
 *
 * The page is only *read* (htmlparser2, no DOM, no script execution); every value is still raw and
 * goes through lib/listings/text.ts before it is stored. JSON-LD is parsed with `JSON.parse` and
 * read through Zod, field by field, so a malformed block only loses that block.
 */

export type ParsedPage = {
  title: string | null
  description: string | null
  siteName: string | null
  /** Absolute http(s) URLs, best first. */
  images: string[]
  icons: string[]
  canonical: string | null
  keywords: string[]
  structured: {
    type: "software" | "product" | null
    name: string | null
    description: string | null
    category: string | null
    price: number | null
    priceCurrency: string | null
    rating: number | null
    ratingCount: number | null
    images: string[]
    keywords: string[]
  }
}

const SOFTWARE_TYPES = new Set([
  "softwareapplication",
  "mobileapplication",
  "webapplication",
  "videogame",
])

function absolute(href: string | undefined | null, base: URL): string | null {
  if (!href) return null
  try {
    const url = new URL(href.trim(), base)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null
  } catch {
    return null
  }
}

const looseNumber = z
  .union([z.number(), z.string().regex(/^\s*-?\d+(?:[.,]\d+)?\s*$/)])
  .transform((v) => (typeof v === "number" ? v : Number(v.replace(",", "."))))
  .pipe(z.number().finite())

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

function stringOf(value: unknown): string | null {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.find((v): v is string => typeof v === "string") ?? null
  return null
}

function imagesOf(value: unknown): string[] {
  const out: string[] = []
  for (const item of asArray(value)) {
    if (typeof item === "string") out.push(item)
    else if (item && typeof item === "object" && "url" in item) {
      const url = (item as { url?: unknown }).url
      if (typeof url === "string") out.push(url)
    }
  }
  return out
}

function typesOf(node: Record<string, unknown>): string[] {
  return asArray(node["@type"])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.toLowerCase())
}

/** Every object in a JSON-LD document, `@graph` flattened. */
function nodesOf(json: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4) return []
  const nodes: Record<string, unknown>[] = []
  for (const item of asArray(json)) {
    if (!item || typeof item !== "object") continue
    const node = item as Record<string, unknown>
    nodes.push(node)
    if (node["@graph"]) nodes.push(...nodesOf(node["@graph"], depth + 1))
  }
  return nodes
}

function readStructured(blocks: string[], base: URL): ParsedPage["structured"] {
  const empty: ParsedPage["structured"] = {
    type: null,
    name: null,
    description: null,
    category: null,
    price: null,
    priceCurrency: null,
    rating: null,
    ratingCount: null,
    images: [],
    keywords: [],
  }
  for (const block of blocks) {
    let json: unknown
    try {
      json = JSON.parse(block)
    } catch {
      continue
    }
    for (const node of nodesOf(json)) {
      const types = typesOf(node)
      const type = types.some((t) => SOFTWARE_TYPES.has(t))
        ? "software"
        : types.includes("product")
          ? "product"
          : null
      if (!type) continue
      const offer = asArray(node.offers).find(
        (o): o is Record<string, unknown> => !!o && typeof o === "object",
      )
      const rating =
        node.aggregateRating && typeof node.aggregateRating === "object"
          ? (node.aggregateRating as Record<string, unknown>)
          : null
      const price = looseNumber.safeParse(offer?.price ?? offer?.lowPrice)
      const ratingValue = looseNumber.safeParse(rating?.ratingValue)
      const ratingCount = looseNumber.safeParse(rating?.ratingCount ?? rating?.reviewCount)
      const currency = stringOf(offer?.priceCurrency)
      const keywords = stringOf(node.keywords)
      return {
        type,
        name: stringOf(node.name),
        description: stringOf(node.description),
        category: stringOf(node.applicationCategory) ?? stringOf(node.category),
        price: price.success && price.data >= 0 ? price.data : null,
        priceCurrency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null,
        rating:
          ratingValue.success && ratingValue.data >= 0 && ratingValue.data <= 5
            ? ratingValue.data
            : null,
        ratingCount:
          ratingCount.success && ratingCount.data >= 0 ? Math.round(ratingCount.data) : null,
        images: imagesOf(node.image)
          .map((src) => absolute(src, base))
          .filter((u): u is string => !!u),
        keywords: keywords ? keywords.split(",") : [],
      }
    }
  }
  return empty
}

export function parseWebPage(html: string, pageUrl: URL): ParsedPage {
  const meta = new Map<string, string>()
  const icons: { href: string; rank: number; size: number }[] = []
  let canonical: string | null = null
  let title = ""
  let inTitle = false
  let titleDone = false
  let ldBuffer: string | null = null
  const ldBlocks: string[] = []

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "title" && !titleDone) inTitle = true
        else if (name === "meta") {
          const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase().trim()
          const content = attrs.content
          if (key && content !== undefined && !meta.has(key)) meta.set(key, content)
        } else if (name === "link") {
          const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/)
          const href = attrs.href
          if (!href) return
          if (rel.includes("canonical")) canonical ??= href
          const size = Number(/(\d+)x\d+/.exec(attrs.sizes ?? "")?.[1] ?? 0)
          if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) {
            icons.push({ href, rank: 0, size })
          } else if (rel.includes("icon")) {
            icons.push({ href, rank: 1, size })
          }
        } else if (
          name === "script" &&
          (attrs.type ?? "").toLowerCase() === "application/ld+json"
        ) {
          ldBuffer = ""
        }
      },
      ontext(text) {
        if (inTitle) title += text
        if (ldBuffer !== null) ldBuffer += text
      },
      onclosetag(name) {
        if (name === "title" && inTitle) {
          inTitle = false
          titleDone = true
        } else if (name === "script" && ldBuffer !== null) {
          if (ldBlocks.length < 10) ldBlocks.push(ldBuffer)
          ldBuffer = null
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )
  parser.write(html)
  parser.end()

  const base = pageUrl
  const structured = readStructured(ldBlocks, base)
  const metaImages = [
    meta.get("og:image:secure_url"),
    meta.get("og:image"),
    meta.get("og:image:url"),
    meta.get("twitter:image"),
    meta.get("twitter:image:src"),
  ]
  const images = [...metaImages.map((src) => absolute(src, base)), ...structured.images].filter(
    (u, i, all): u is string => !!u && all.indexOf(u) === i,
  )
  icons.sort((a, b) => a.rank - b.rank || b.size - a.size)
  const iconUrls = icons
    .map((icon) => absolute(icon.href, base))
    .filter((u, i, all): u is string => !!u && all.indexOf(u) === i)

  return {
    title:
      meta.get("og:title") ??
      meta.get("twitter:title") ??
      structured.name ??
      (title.trim() || null),
    description:
      meta.get("og:description") ??
      meta.get("twitter:description") ??
      meta.get("description") ??
      structured.description,
    siteName: meta.get("og:site_name") ?? meta.get("application-name") ?? null,
    images,
    icons: iconUrls,
    canonical: absolute(canonical, base),
    keywords: (meta.get("keywords") ?? "").split(",").filter((k) => k.trim() !== ""),
    structured,
  }
}

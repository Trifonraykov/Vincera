import { normalizeTopic } from "@/lib/social/summary-form"
import { SUPPLY_TITLE_MAX, TOPIC_MAX_LENGTH, TOPICS_MAX } from "@/lib/supply/fields"

/**
 * Text taken from other people's pages and stores (CLAUDE.md §19.45). Client-safe, pure.
 *
 * Every string an import stores goes through these: Unicode NFC, control and format characters
 * (bidi overrides, zero-width joiners used to hide text) removed, HTML tags stripped where they
 * could appear, whitespace collapsed, and a hard length cap. The result is plain text: pages render
 * descriptions through `renderMarkdown` (sanitized) and titles as React text, never as HTML.
 */

export const LISTING_DESCRIPTION_MAX = 5000
export const LISTING_TAGLINE_MAX = 140

// C0/C1 controls except tab and newline, plus Unicode format characters (Cf: bidi, ZW*).
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/gu
const TAGS = /<\/?[a-z][^>]*>/gi

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  const cut = value.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** One line: no tags, no controls, whitespace collapsed, at most `max` characters. */
export function cleanLine(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  const text = value
    .normalize("NFC")
    .replace(TAGS, " ")
    .replace(UNSAFE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
  return text === "" ? null : clip(text, max)
}

/** Paragraph text: line breaks kept (at most one blank line), everything else like `cleanLine`. */
export function cleanParagraphs(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  const text = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(TAGS, " ")
    .replace(UNSAFE_CHARS, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text === "" ? null : clip(text, max)
}

export function cleanTitle(value: string | null | undefined): string | null {
  return cleanLine(value, SUPPLY_TITLE_MAX)
}

/**
 * The feed's one short line: the description's first sentence (or first line), no AI involved,
 * at most 140 characters.
 */
/** Markdown marks a typed description may hold (`**bold**`, `[link](url)`, `# heading`, …). */
function plainMarkdown(value: string): string {
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|`|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
}

export function taglineOf(description: string | null | undefined): string | null {
  const text = cleanParagraphs(
    description ? plainMarkdown(description) : description,
    LISTING_DESCRIPTION_MAX,
  )
  if (!text) return null
  const firstLine = text.split("\n").find((line) => /[\p{L}\p{N}]/u.test(line)) ?? ""
  const bullet = firstLine.replace(/^[-*•·–—]\s*/, "")
  const sentence = /^(.+?[.!?])(\s|$)/u.exec(bullet)?.[1] ?? bullet
  return cleanLine(sentence, LISTING_TAGLINE_MAX)
}

/** Topics from categories / keywords: the shared topic rules, ≤ 8, each ≤ 40 characters. */
export function topicsFrom(values: readonly (string | null | undefined)[]): string[] {
  const topics: string[] = []
  for (const value of values) {
    for (const part of (value ?? "").split(/[,;|/]/)) {
      const topic = normalizeTopic(cleanLine(part, 200) ?? "")
      if (!topic || topic.length > TOPIC_MAX_LENGTH || topics.includes(topic)) continue
      if (!/[\p{L}\p{N}]/u.test(topic) || topic.includes("@")) continue
      topics.push(topic)
      if (topics.length >= TOPICS_MAX) return topics
    }
  }
  return topics
}

/** `https://www.Example.com/path` → `example.com`. */
export function displayDomain(url: string | URL): string {
  try {
    const host = (typeof url === "string" ? new URL(url) : url).hostname.toLowerCase()
    return host.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** An http(s) link fit for `demo_url` / `source_url` (≤ 500 characters), or null. */
export function safeLink(value: string | null | undefined): string | null {
  if (!value || /\s/.test(value.trim())) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password) return null
    url.hash = ""
    const href = url.href
    return href.length <= 500 ? href : null
  } catch {
    return null
  }
}

/** A stable 0–359 hue from a string (the generated visual's colours). */
export function hueOf(seed: string): number {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 360
}

import "server-only"

import { Marked } from "marked"
import sanitizeHtml from "sanitize-html"

/**
 * User-written Markdown → safe HTML (§14 "Sanitize user markdown (product descriptions, messages)
 * before rendering"; CLAUDE.md §19.24). Server-side only: `marked` (GFM, single line breaks kept)
 * then `sanitize-html` with a small allow-list. No raw HTML survives, no images (they would load
 * third-party URLs in other people's browsers), links are http(s)/mailto only and open in a new
 * tab with `rel="nofollow noopener noreferrer"`. Render the result with
 * `dangerouslySetInnerHTML` inside a `prose`-style container; never render user Markdown any
 * other way.
 */

const markdown = new Marked({ gfm: true, breaks: true, async: false })

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "h3",
  "h4",
  "hr",
]

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  // target and rel are always the transform's values (it overrides whatever the source said).
  allowedAttributes: { a: ["href", "target", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  // Headings from `#` / `##` become h3 so user text never outranks the page's own headings.
  transformTags: {
    h1: "h3",
    h2: "h3",
    h5: "h4",
    h6: "h4",
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "nofollow noopener noreferrer",
    }),
  },
  disallowedTagsMode: "discard",
}

/** Render user Markdown to sanitized HTML. Empty input gives an empty string. */
export function renderMarkdown(source: string): string {
  if (source.trim() === "") return ""
  const html = markdown.parse(source)
  if (typeof html !== "string") throw new Error("renderMarkdown: marked returned a promise")
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim()
}

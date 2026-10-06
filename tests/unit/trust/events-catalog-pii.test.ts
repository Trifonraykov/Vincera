import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { isForbiddenPropertyKey } from "@/lib/events/pii"

/**
 * §11 "Never put message bodies, emails, or tokens into event properties" (CLAUDE.md §19.40
 * audit): every property key declared in the typed event catalog (lib/events/types.ts) is checked
 * against the runtime PII guard's words and a stricter list of free-text and identity fields.
 * The catalog is types only, so the test reads its source.
 */

const CATALOG = readFileSync(path.join(process.cwd(), "lib/events/types.ts"), "utf8")

/** Free text or identity data that has no place in an event (beyond the runtime guard's words). */
const FREE_TEXT_KEYS = new Set([
  "message",
  "description",
  "note",
  "comment",
  "text",
  "name",
  "display_name",
  "typed_name",
  "title",
  "handle",
  "ip",
  "user_agent",
  "address",
  "url",
  "bio",
  "scope",
])

function propertyKeys(source: string): string[] {
  const keys = new Set<string>()
  let index = 0
  for (;;) {
    const start = source.indexOf("properties:", index)
    if (start < 0) break
    const open = source.indexOf("{", start)
    let depth = 0
    let end = open
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1
      else if (source[end] === "}") {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = source
      .slice(open + 1, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
    for (const match of body.matchAll(/([a-z_][a-z0-9_]*)\??\s*:/g)) {
      if (match[1]) keys.add(match[1])
    }
    index = end
  }
  return [...keys].sort()
}

describe("event catalog property keys", () => {
  const keys = propertyKeys(CATALOG)

  it("finds the catalog's properties", () => {
    expect(keys.length).toBeGreaterThan(50)
    expect(keys).toContain("collab_id")
  })

  it("declares no key the runtime PII guard would refuse", () => {
    expect(keys.filter((key) => isForbiddenPropertyKey(key))).toEqual([])
  })

  it("declares no free-text or identity field", () => {
    expect(keys.filter((key) => FREE_TEXT_KEYS.has(key))).toEqual([])
  })
})

/**
 * Secrets that can appear in URLs, removed before anything reaches PostHog or Sentry (§11, §14;
 * CLAUDE.md §19.37). Client-safe and dependency-free: the browser, edge and server SDK configs use
 * it.
 *
 * - `/access/<token>`: the buyer's access token is their only credential (§19.31), so the path
 *   segment becomes `/access/[token]` wherever it appears (page URLs, referrers, link `href`s in
 *   autocapture's element chains, Sentry request paths and breadcrumbs).
 * - Query values that act as credentials or identify a person: Checkout's `session_id` (the
 *   success page shows the access link for it), magic-link `token` and `email`, OAuth `code` and
 *   `state`, storage signatures. The parameter stays, its value becomes `[redacted]`.
 */

const ACCESS_PATH = /\/access\/[A-Za-z0-9_-]{16,}/g
const SECRET_QUERY = /([?&;]|&amp;)(session_id|token|email|code|state|sig|signature)=[^&#\s"'<>]*/gi

export function redactSensitiveText(text: string): string {
  if (!text.includes("/access/") && !text.includes("=")) return text
  return text
    .replace(ACCESS_PATH, "/access/[token]")
    .replace(
      SECRET_QUERY,
      (_match, separator: string, name: string) => `${separator}${name}=[redacted]`,
    )
}

/**
 * `redactSensitiveText` applied to every string inside a JSON-like value, in place (objects and
 * arrays are walked; anything else is left alone). Returns the value.
 */
export function redactDeep<T>(value: T): T {
  const seen = new WeakSet<object>()
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactSensitiveText(node)
    if (!node || typeof node !== "object") return node
    if (seen.has(node)) return node
    seen.add(node)
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) node[index] = walk(node[index])
      return node
    }
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (typeof item === "string" || (item && typeof item === "object")) record[key] = walk(item)
    }
    return node
  }
  return walk(value) as T
}

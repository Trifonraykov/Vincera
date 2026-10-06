/**
 * Cheap defense for the §11 rule "never put message bodies, emails or tokens into event
 * properties": flags keys whose words look like personal data or secrets, and string values that
 * contain an email address. It is a safety net, not a substitute for the typed event catalog.
 */

/** Words that must not appear in a property key (split on `_`, `-`, `.` and camelCase). */
const FORBIDDEN_KEY_WORDS = new Set([
  "email",
  "body",
  "token",
  "password",
  "passwd",
  "secret",
  "cookie",
  "authorization",
  "phone",
])

const EMAIL_IN_TEXT = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}/i

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function isForbiddenPropertyKey(key: string): boolean {
  return keyWords(key).some((word) => FORBIDDEN_KEY_WORDS.has(word))
}

export function looksLikeEmail(value: string): boolean {
  return EMAIL_IN_TEXT.test(value)
}

export type PiiFinding = {
  /** Dotted path of the offending key or value, e.g. `meta.buyer_email` or `tags[2]`. */
  path: string
  reason: "key" | "email_value"
}

/** Every key or string value in `value` (recursively) that looks like PII. */
export function findPii(value: unknown, path = ""): PiiFinding[] {
  if (typeof value === "string") {
    return looksLikeEmail(value) ? [{ path: path || "(value)", reason: "email_value" }] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPii(item, `${path}[${index}]`))
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key
      return isForbiddenPropertyKey(key)
        ? [{ path: childPath, reason: "key" as const }]
        : findPii(child, childPath)
    })
  }
  return []
}

/** A copy of `value` without forbidden keys, with email-like strings replaced by "[redacted]". */
export function scrubPii(value: unknown): unknown {
  if (typeof value === "string") return looksLikeEmail(value) ? "[redacted]" : value
  if (Array.isArray(value)) return value.map(scrubPii)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isForbiddenPropertyKey(key))
        .map(([key, child]) => [key, scrubPii(child)]),
    )
  }
  return value
}

export class EventPiiError extends Error {
  readonly findings: readonly PiiFinding[]

  constructor(type: string, findings: readonly PiiFinding[]) {
    // Paths only: the offending values are never echoed.
    super(
      `Event "${type}" has properties that look like personal data or secrets (§11): ` +
        findings.map((f) => `${f.path} (${f.reason === "key" ? "key" : "email value"})`).join(", "),
    )
    this.name = "EventPiiError"
    this.findings = findings
  }
}

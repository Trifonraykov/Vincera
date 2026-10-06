/** Small helpers shared by the idea and product writes (lib/ideas/save.ts, lib/products/save.ts). */

export function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Topics as event properties (§11: ids, enums, counts; never personal data). Topics are short
 * labels people type, so one that looks like an email address or a handle is left out of the
 * event rather than letting the PII guard (lib/events/pii.ts) fail the save.
 */
export function eventTopics(topics: readonly string[]): string[] {
  return topics.filter((topic) => !topic.includes("@"))
}

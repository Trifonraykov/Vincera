/**
 * The pure part of the tag input (./tag-input.tsx), so it can be unit-tested: splitting what was
 * typed into finished tags and the part still being typed, and adding tags to a list.
 */

/** Whitespace collapsed and trimmed, then the field's own normalisation (e.g. lowercase topics). */
export function cleanTag(value: string, normalize: (tag: string) => string = (tag) => tag): string {
  return normalize(value.replace(/\s+/g, " ").trim())
}

/**
 * "a, b, c" → finished ["a", "b"], still typing "c". A comma or line break ends a tag, so a pasted
 * list becomes tags at once.
 */
export function splitTyped(value: string): { finished: string[]; draft: string } {
  const parts = value.split(/[,\n]/)
  if (parts.length === 1) return { finished: [], draft: value }
  return { finished: parts.slice(0, -1), draft: parts.at(-1)?.trimStart() ?? "" }
}

/**
 * Add `values` to `tags`: cleaned, empty ones and duplicates (ignoring case) dropped, at most
 * `max` in total. `overflow` lists the tags that did not fit, so the input can keep them.
 */
export function addTags(
  tags: readonly string[],
  values: readonly string[],
  options: { max: number; normalize?: (tag: string) => string },
): { tags: string[]; added: string[]; overflow: string[] } {
  const next = [...tags]
  const added: string[] = []
  const overflow: string[] = []
  for (const value of values) {
    const tag = cleanTag(value, options.normalize)
    if (!tag) continue
    if (next.some((existing) => existing.toLowerCase() === tag.toLowerCase())) continue
    if (next.length >= options.max) {
      overflow.push(tag)
      continue
    }
    next.push(tag)
    added.push(tag)
  }
  return { tags: next, added, overflow }
}

/** What the form submits: the tags plus any text still being typed, as one comma list. */
export function submittedTags(
  tags: readonly string[],
  draft: string,
  normalize?: (tag: string) => string,
): string {
  const pending = cleanTag(draft, normalize)
  return [...tags, ...(pending ? [pending] : [])].join(", ")
}

/**
 * Best-effort topic keywords for `audience_snapshots.top_topics` (§5), derived from recent
 * content: hashtags and explicit tags count double, title/caption words once, and a term must
 * appear in at least two items (one when there are fewer than three). The AI audience summary
 * produces the curated topics; these are only a cheap, deterministic signal. Client-safe.
 */

export const MAX_SNAPSHOT_TOPICS = 8

const STOPWORDS = new Set(
  (
    "about above after again against all also am an and any are around as at be because been " +
    "before being below best between both but by can could did do does doing down during each " +
    "even ever every few first for from further get gets getting go going got had has have " +
    "having he her here hers him his how i if in into is it its just last like make makes " +
    "making many me more most much must my never new next no nor not now of off on once one " +
    "only or other our ours out over own part really same she should since so some such than " +
    "that the their theirs them then there these they thing things this those through to too " +
    "under until up us very via want was way ways we were what when where which while who why " +
    "will with without would yes yet you your yours " +
    // Platform and format words that say nothing about the audience.
    "channel video videos vlog short shorts reel reels post posts live stream episode official " +
    "subscribe follow like comment share watch today week day days year years youtube tiktok " +
    "instagram insta fyp foryou foryoupage viral trending part pt full update edition"
  ).split(" "),
)

const HASHTAG = /#([\p{L}\p{N}_]{2,40})/gu
const URL_OR_MENTION = /(https?:\/\/\S+|@[\p{L}\p{N}_.]+)/gu
const WORD = /[\p{L}][\p{L}\p{N}'’-]*/gu

function normalizeTag(tag: string): string | null {
  const cleaned = tag
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[\s_]+/g, " ")
    .trim()
  if (cleaned.length < 2 || cleaned.length > 40) return null
  if (cleaned.split(" ").length > 3) return null
  if (STOPWORDS.has(cleaned) || /^\d+$/.test(cleaned)) return null
  return cleaned
}

function words(text: string): string[] {
  const stripped = text.replace(HASHTAG, " ").replace(URL_OR_MENTION, " ")
  const out: string[] = []
  for (const match of stripped.matchAll(WORD)) {
    const word = match[0]
      .toLowerCase()
      .replace(/['’-]+$/g, "")
      .replace(/['’]s$/, "")
    if (word.length >= 4 && word.length <= 30 && !STOPWORDS.has(word)) out.push(word)
  }
  return out
}

export type TopicSource = { text?: string | null; tags?: readonly string[] | null }

export function deriveTopics(
  items: readonly TopicSource[],
  max: number = MAX_SNAPSHOT_TOPICS,
): string[] {
  const scores = new Map<string, { score: number; items: number }>()
  for (const item of items) {
    const strong = new Set<string>()
    const weak = new Set<string>()
    const text = item.text ?? ""
    for (const match of text.matchAll(HASHTAG)) {
      const tag = normalizeTag(match[1] ?? "")
      if (tag) strong.add(tag)
    }
    for (const tag of item.tags ?? []) {
      const normalized = normalizeTag(tag)
      if (normalized) strong.add(normalized)
    }
    for (const word of words(text)) if (!strong.has(word)) weak.add(word)

    for (const [terms, weight] of [
      [strong, 2],
      [weak, 1],
    ] as const) {
      for (const term of terms) {
        const entry = scores.get(term) ?? { score: 0, items: 0 }
        entry.score += weight
        entry.items += 1
        scores.set(term, entry)
      }
    }
  }

  const minItems = items.length >= 3 ? 2 : 1
  return [...scores.entries()]
    .filter(([, entry]) => entry.items >= minItems)
    .sort(([a, x], [b, y]) => y.score - x.score || y.items - x.items || a.localeCompare(b))
    .slice(0, max)
    .map(([term]) => term)
}

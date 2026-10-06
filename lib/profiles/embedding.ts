import "server-only"

import { PRODUCT_FORMAT_LABELS } from "./fields"

/**
 * The text of the builder profile embedding (§5 `builder_profiles.embedding`, §8 `semantic`):
 * what they build: skills, stack, bio and portfolio. No names or handles. Creators' text is in
 * lib/social/derived.ts (it includes the audience summary). The `embeddings-refresh` job
 * (lib/embeddings, CLAUDE.md §19.25) embeds both.
 */

type BuilderEmbeddingInput = {
  bio: string | null
  skills: readonly string[]
  stack: readonly string[]
  portfolio: readonly {
    title: string
    description: string | null
    format: keyof typeof PRODUCT_FORMAT_LABELS | null
    isShipped: boolean
  }[]
}

export function builderProfileEmbeddingText(input: BuilderEmbeddingInput): string {
  const lines = [
    input.skills.length > 0 ? `Skills: ${input.skills.join(", ")}` : null,
    input.stack.length > 0 ? `Stack: ${input.stack.join(", ")}` : null,
    input.bio ? `About: ${input.bio}` : null,
    ...input.portfolio.map((item) => {
      const kind = item.format ? `${PRODUCT_FORMAT_LABELS[item.format]}, ` : ""
      const status = item.isShipped ? "shipped" : "in progress"
      const description = item.description ? `: ${item.description}` : ""
      return `Built: ${item.title} (${kind}${status})${description}`
    }),
  ]
  return lines.filter((line): line is string => line !== null).join("\n")
}

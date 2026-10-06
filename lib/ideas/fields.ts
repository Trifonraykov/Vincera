import { z } from "zod"

import {
  formatSchema,
  intentSchema,
  optionalLongText,
  priceSchema,
  titleSchema,
  topicsSchema,
  type SupplyFieldErrors,
} from "@/lib/supply/fields"

/**
 * The idea form (§5 ideas: title, problem, audience evidence, format, target price, topics; §12
 * `/app/ideas/new`, `/app/ideas/[id]`). Client-safe: the form and the server actions share these
 * limits and the schema.
 */

export const IDEA_PROBLEM_MAX = 2000
export const IDEA_EVIDENCE_MAX = 2000
/** The idea brief drafter's input (§7.3.2): pasted audience comments. */
export const IDEA_COMMENTS_MAX = 8000
export const IDEA_COMMENTS_MIN = 20

export const ideaFieldsSchema = z.object({
  title: titleSchema("idea"),
  problem: optionalLongText(
    IDEA_PROBLEM_MAX,
    `Keep the problem under ${IDEA_PROBLEM_MAX.toLocaleString("en-US")} characters.`,
  ),
  audienceEvidence: optionalLongText(
    IDEA_EVIDENCE_MAX,
    `Keep the evidence under ${IDEA_EVIDENCE_MAX.toLocaleString("en-US")} characters.`,
  ),
  format: formatSchema,
  targetPrice: priceSchema,
  topics: topicsSchema,
})
export type IdeaFields = z.output<typeof ideaFieldsSchema>

/** The whole form: the fields plus which button was pressed. */
export const ideaFormSchema = ideaFieldsSchema.extend({ intent: intentSchema })
export type IdeaForm = z.output<typeof ideaFormSchema>

/** The form's field names, for field errors and focusing. */
export const IDEA_FIELD_NAMES = [
  "title",
  "problem",
  "audienceEvidence",
  "format",
  "targetPrice",
  "topics",
] as const

/**
 * What an idea needs before builders see it (decided in §19.25): the problem to solve (what the
 * builder would build against) and at least one topic (matching's `topic_overlap`). Drafts can
 * be saved with only a title and a format. Empty when it can be published.
 */
export function ideaPublishProblems(
  fields: Pick<IdeaFields, "problem" | "topics">,
): SupplyFieldErrors {
  const problems: SupplyFieldErrors = {}
  if (!fields.problem) problems.problem = ["Describe the problem before publishing."]
  if (fields.topics.length === 0) {
    problems.topics = ["Add at least one topic before publishing, so builders can find it."]
  }
  return problems
}

/** Column names (snake_case) of the editable fields, for `idea.updated { fields }`. */
export const IDEA_COLUMNS: Record<keyof IdeaFields, string> = {
  title: "title",
  problem: "problem",
  audienceEvidence: "audience_evidence",
  format: "format",
  targetPrice: "target_price_cents",
  topics: "topics",
}

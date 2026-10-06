import { z } from "zod"

/**
 * The editable audience summary (§7.3 use 1: "the creator can edit it on
 * /onboarding/creator/review"; also on /app/audience). Client-safe: the same limits as the AI
 * output (lib/ai/prompts/audience-summary.ts), so a generated summary always fits the form.
 */

export const SUMMARY_MAX_LENGTH = 1200
export const TOPICS_MAX = 8
export const TOPIC_MAX_LENGTH = 40

/**
 * One topic as stored: lowercase, a leading "#" dropped (after the surrounding spaces, so
 * " #budget" and "#budget" are both "budget"), "_" and runs of whitespace as one space. The one
 * rule for the creator's topics (this form, the profile form) and the AI's
 * (`normalizeAudienceSummary`), so §8's topic overlap compares like with like.
 */
export function normalizeTopic(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[\s_]+/g, " ")
    .trim()
}

/** "Fitness, Meal prep ,#budget" → ["fitness", "meal prep", "budget"] (deduplicated, ≤ 8). */
export function parseTopicsInput(value: string): string[] {
  const topics: string[] = []
  for (const part of value.split(/[,\n]/)) {
    const topic = normalizeTopic(part)
    if (topic && !topics.includes(topic)) topics.push(topic)
  }
  return topics
}

/**
 * Browsers submit a textarea's line breaks as CRLF, while its `maxLength` and the on-page counter
 * count each as one character; normalise first, so a summary that fits on screen fits here.
 */
function normalizeLineBreaks(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value
}

export const audienceSummaryFormSchema = z.object({
  summary: z
    .preprocess(
      normalizeLineBreaks,
      z
        .string()
        .max(SUMMARY_MAX_LENGTH, `Keep the summary under ${SUMMARY_MAX_LENGTH} characters.`),
    )
    .transform((value) => value.replace(/\s+/g, " ").trim()),
  topics: z
    .string()
    .max(1000, "That's too many topics.")
    .transform(parseTopicsInput)
    .pipe(
      z
        .array(
          z.string().max(TOPIC_MAX_LENGTH, `Keep each topic under ${TOPIC_MAX_LENGTH} characters.`),
        )
        .max(TOPICS_MAX, `Pick at most ${TOPICS_MAX} topics.`),
    ),
})
export type AudienceSummaryForm = z.output<typeof audienceSummaryFormSchema>

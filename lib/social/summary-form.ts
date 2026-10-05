import { z } from "zod"

/**
 * The editable audience summary (§7.3 use 1: "the creator can edit it on
 * /onboarding/creator/review"; also on /app/audience). Client-safe: the same limits as the AI
 * output (lib/ai/prompts/audience-summary.ts), so a generated summary always fits the form.
 */

export const SUMMARY_MAX_LENGTH = 1200
export const TOPICS_MAX = 8
export const TOPIC_MAX_LENGTH = 40

/** "Fitness, Meal prep ,#budget" → ["fitness", "meal prep", "budget"] (deduplicated, ≤ 8). */
export function parseTopicsInput(value: string): string[] {
  const topics: string[] = []
  for (const part of value.split(/[,\n]/)) {
    const topic = part
      .toLowerCase()
      .replace(/^#+/, "")
      .replace(/[\s_]+/g, " ")
      .trim()
    if (topic && !topics.includes(topic)) topics.push(topic)
  }
  return topics
}

export const audienceSummaryFormSchema = z.object({
  summary: z
    .string()
    .max(SUMMARY_MAX_LENGTH, `Keep the summary under ${SUMMARY_MAX_LENGTH} characters.`)
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

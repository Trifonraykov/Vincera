import { z } from "zod"

/**
 * Proposal terms (§5 proposal_revisions; §12 `/app/proposals/new`): limits, labels and the Zod
 * schemas shared by the proposal form, the counter-offer form and the server actions. Client-safe.
 *
 * A revision's splits are whole percentages, 0–100 each, that add up to exactly 100 (the database
 * checks it too: `proposal_revisions_split_valid`). The timeline is a whole number of weeks.
 */

export const PROPOSAL_MESSAGE_MAX = 2000
export const PROPOSAL_SCOPE_MAX = 2000
export const TIMELINE_WEEKS_MIN = 1
export const TIMELINE_WEEKS_MAX = 52
/** The split the form starts from when the target suggests none. */
export const DEFAULT_CREATOR_SPLIT_PCT = 50
export const DEFAULT_TIMELINE_WEEKS = 4

export const SPLIT_SUM_MESSAGE = "The creator's and builder's shares must add up to 100%."

/** What `validateSplit` says about a pair of shares; null when they are valid. */
export function validateSplit(creatorPct: number, builderPct: number): string | null {
  for (const [label, value] of [
    ["creator", creatorPct],
    ["builder", builderPct],
  ] as const) {
    if (!Number.isInteger(value)) return `Enter the ${label}'s share as a whole number.`
    if (value < 0 || value > 100) return `The ${label}'s share must be between 0% and 100%.`
  }
  return creatorPct + builderPct === 100 ? null : SPLIT_SUM_MESSAGE
}

/** The other side of a split: what the builder gets for a creator share, and vice versa. */
export function complementPct(pct: number): number {
  return 100 - Math.min(100, Math.max(0, Math.round(pct)))
}

/** Whole numbers typed into a form ("60", " 60 ", "60%"); empty stays missing. */
function wholeNumber(message: string) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") return value
      const trimmed = value.trim().replace(/%$/, "").trim()
      return trimmed === "" ? undefined : trimmed
    },
    z.coerce.number({ error: message }).int(message),
  )
}

/** Browsers submit textarea line breaks as CRLF; limits count the text as it is stored. */
function normalizeText(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : value
}

/** Optional text: empty or missing is null. */
function optionalText(max: number, tooLong: string) {
  return z.preprocess((value) => {
    const text = normalizeText(value)
    return text === undefined || text === "" ? null : text
  }, z.string().max(max, tooLong).nullable())
}

const percent = (label: "creator" | "builder") =>
  wholeNumber(`Enter the ${label}'s share as a whole number.`).pipe(
    z
      .number()
      .min(0, `The ${label}'s share must be between 0% and 100%.`)
      .max(100, `The ${label}'s share must be between 0% and 100%.`),
  )

/** The fields of one offer: what the proposal form and the counter-offer form submit. */
export const proposalTermsFields = {
  message: optionalText(
    PROPOSAL_MESSAGE_MAX,
    `Keep your message under ${PROPOSAL_MESSAGE_MAX.toLocaleString("en")} characters.`,
  ),
  scope: z.preprocess(
    normalizeText,
    z
      .string({ error: "Describe what you'll build together." })
      .min(1, "Describe what you'll build together.")
      .max(
        PROPOSAL_SCOPE_MAX,
        `Keep the scope under ${PROPOSAL_SCOPE_MAX.toLocaleString("en")} characters.`,
      ),
  ),
  creatorSplitPct: percent("creator"),
  builderSplitPct: percent("builder"),
  timelineWeeks: wholeNumber("Enter the timeline in whole weeks.").pipe(
    z
      .number()
      .min(TIMELINE_WEEKS_MIN, `The timeline must be at least ${TIMELINE_WEEKS_MIN} week.`)
      .max(TIMELINE_WEEKS_MAX, `Keep the timeline under ${TIMELINE_WEEKS_MAX + 1} weeks.`),
  ),
}

/**
 * Adds the "shares add up to 100" check to an object holding `proposalTermsFields` (extend the
 * fields first: Zod refuses to extend an object that already has refinements).
 */
export function withSplitCheck<
  T extends z.ZodType<{ creatorSplitPct: number; builderSplitPct: number }>,
>(schema: T): T {
  return schema.superRefine((terms, context) => {
    if (terms.creatorSplitPct + terms.builderSplitPct !== 100) {
      context.addIssue({ code: "custom", path: ["creatorSplitPct"], message: SPLIT_SUM_MESSAGE })
    }
  })
}

/** The terms of one offer. */
export const proposalTermsSchema = withSplitCheck(z.object(proposalTermsFields))

export type ProposalTerms = z.output<typeof proposalTermsSchema>
export type ProposalTermsInput = z.input<typeof proposalTermsSchema>

/** Labels for the parts of a revision, as the history shows them. */
export const TERM_LABELS = {
  split: "Split",
  timelineWeeks: "Timeline",
  scope: "Scope",
  message: "Message",
} as const

export function formatTimeline(weeks: number): string {
  return weeks === 1 ? "1 week" : `${weeks} weeks`
}

export function formatSplit(terms: { creatorSplitPct: number; builderSplitPct: number }): string {
  return `Creator ${terms.creatorSplitPct}% · Builder ${terms.builderSplitPct}%`
}

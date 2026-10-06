import { z } from "zod"

import type { DisputeKind, DisputeOutcome, DisputeStatus } from "@/lib/db/schema/enums"

/**
 * Collab disputes (§5 `disputes`, §16 Phase 6; CLAUDE.md §19.38, §19.40): the form a member fills
 * in, and the words the app shows for kinds, statuses and outcomes. Client-safe.
 */

export const DISPUTE_KINDS = [
  "split",
  "non_delivery",
  "exit",
  "other",
] as const satisfies readonly DisputeKind[]

export const DISPUTE_DESCRIPTION_MAX = 2000

export const DISPUTE_KIND_LABELS: Record<DisputeKind, string> = {
  split: "The split",
  non_delivery: "Work not delivered",
  exit: "Leaving the collab",
  other: "Something else",
}

export const DISPUTE_KIND_HINTS: Record<DisputeKind, string> = {
  split: "The agreed shares no longer reflect the work, or a payment looks wrong.",
  non_delivery: "Something that was agreed was not built, sent or done.",
  exit: "You or your collaborator want to stop working together.",
  other: "Anything else our team should look into.",
}

export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  open: "Open",
  in_review: "In review",
  resolved: "Resolved",
}

export const DISPUTE_STATUS_DESCRIPTIONS: Record<DisputeStatus, string> = {
  open: "Waiting for our team to pick it up.",
  in_review: "Our team is looking into it and may message you both.",
  resolved: "Our team made a decision.",
}

export const DISPUTE_OUTCOME_LABELS: Record<DisputeOutcome, string> = {
  no_action: "Closed without changes",
  adjusted: "Earnings adjusted",
  collab_ended: "Collab ended",
  other: "Other decision",
}

/** The "Raise a dispute" form. CRLF becomes LF before the length check (§19.14). */
export const raiseDisputeSchema = z.object({
  collabId: z.uuid(),
  kind: z.enum(DISPUTE_KINDS, { error: "Pick what the dispute is about." }),
  description: z
    .string({ error: "Describe what happened." })
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .pipe(
      z
        .string()
        .min(20, "Describe what happened in a few sentences (at least 20 characters).")
        .max(DISPUTE_DESCRIPTION_MAX, `Keep it under ${DISPUTE_DESCRIPTION_MAX} characters.`),
    ),
})

export type RaiseDisputeInput = z.output<typeof raiseDisputeSchema>

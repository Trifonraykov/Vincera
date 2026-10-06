import { z } from "zod"

import type {
  CollabStage,
  DisputeKind,
  DisputeOutcome,
  DisputeStatus,
  TransferStatus,
} from "@/lib/db/schema/enums"
import { looksLikeEmail } from "@/lib/events/pii"

/**
 * Client-safe pieces of the admin area (Phase 6; CLAUDE.md §19.39): form schemas, limits and
 * labels. Admin-written notes end up in `admin_audit_log`, whose snapshots refuse anything that
 * looks like an email (lib/admin/audit.ts), so the schemas refuse them first with a plain message.
 */

export const IMPERSONATION_REASON_MAX = 500
export const RESOLUTION_NOTE_MAX = 2000
export const ADJUSTMENT_REASON_MAX = 500
export const ADJUSTMENT_MAX_LINES = 6
/** One line moves at most €100,000 (a typo guard, not a business rule). */
export const ADJUSTMENT_LINE_MAX_CENTS = 10_000_000

const NO_EMAIL = "Leave email addresses out: this note is kept in the audit log."

/** A trimmed, non-blank admin note without email addresses. */
export function adminNote(max: number, required: string) {
  return z
    .string({ error: required })
    .trim()
    .min(1, required)
    .max(max, `Keep it under ${max.toLocaleString("en")} characters.`)
    .refine((value) => !looksLikeEmail(value), NO_EMAIL)
}

export const DISPUTE_OUTCOMES = [
  "no_action",
  "adjusted",
  "collab_ended",
  "other",
] as const satisfies readonly DisputeOutcome[]

export const OUTCOME_LABELS: Record<DisputeOutcome, string> = {
  no_action: "No action needed",
  adjusted: "Ledger adjustment",
  collab_ended: "End the collab",
  other: "Other",
}

export const OUTCOME_HINTS: Record<DisputeOutcome, string> = {
  no_action: "The members sorted it out, or nothing needs to change.",
  adjusted: "Move money between the members (or the platform) with entries that sum to zero.",
  collab_ended:
    "End the collab and any live launch. An idea or product that never launched goes back on offer.",
  other: "Something else; explain it in the note.",
}

export const DISPUTE_STATUS_TEXT: Record<DisputeStatus, string> = {
  open: "Open",
  in_review: "In review",
  resolved: "Resolved",
}

export const DISPUTE_KIND_TEXT: Record<DisputeKind, string> = {
  split: "Split",
  non_delivery: "Non-delivery",
  exit: "Exit",
  other: "Other",
}

export const STAGE_TEXT: Record<CollabStage, string> = {
  agreement: "Agreement",
  building: "Building",
  launch_review: "Launch review",
  live: "Live",
  ended: "Ended",
}

export const TRANSFER_STATUS_TEXT: Record<TransferStatus, string> = {
  pending: "Pending",
  created: "Paid",
  failed: "Failed",
  reversed: "Reversed",
  partially_reversed: "Partly reversed",
}

/**
 * Euros typed by an admin ("5", "-5", "−12.50", "3,20") → integer cents, or null. Signed:
 * adjustment lines take money from someone (negative) and give it to someone else (positive).
 */
export function parseSignedCents(raw: string): number | null {
  const text = raw.trim().replace(/[\s€]/g, "").replace(/^−/, "-")
  if (!/^[+-]?\d{1,6}([.,]\d{1,2})?$/.test(text)) return null
  const negative = text.startsWith("-")
  const [whole = "0", fraction = ""] = text.replace(/^[+-]/, "").split(/[.,]/)
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return negative ? -cents : cents
}

const uuid = z.uuid({ error: "That link is not valid." })

export const adjustmentLineSchema = z.object({
  /** "platform" for the platform's own side (user null), else a member's user id. */
  party: z.union([z.literal("platform"), z.uuid({ error: "Pick who the line is for." })]),
  amount: z.string().trim().min(1, "Enter an amount."),
})

/** The adjustment form (dispute page and payouts page). */
export const adjustmentFormSchema = z.object({
  disputeId: uuid.optional(),
  orderId: z.preprocess((value) => (value === "" ? undefined : value), uuid.optional()),
  reason: adminNote(ADJUSTMENT_REASON_MAX, "Say why, for the audit log."),
  lines: z
    .array(adjustmentLineSchema)
    .min(2, "An adjustment has at least two lines.")
    .max(ADJUSTMENT_MAX_LINES, `At most ${ADJUSTMENT_MAX_LINES} lines.`),
})

export type AdjustmentFormInput = z.input<typeof adjustmentFormSchema>

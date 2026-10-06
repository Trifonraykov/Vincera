import { z } from "zod"

/**
 * GDPR account deletion (§14; CLAUDE.md §19.38, §19.40): the typed confirmation and the
 * plain-language reasons deletion is refused. Client-safe.
 */

/** What the person types to confirm. */
export const DELETE_CONFIRMATION = "DELETE"

export const deleteAccountSchema = z.object({
  confirmation: z
    .string({ error: `Type ${DELETE_CONFIRMATION} to confirm.` })
    .trim()
    .refine((value) => value === DELETE_CONFIRMATION, `Type ${DELETE_CONFIRMATION} to confirm.`),
})

export const DELETION_BLOCKERS = [
  "active_collabs",
  "open_disputes",
  "unpaid_balance",
  "pending_transfer",
] as const

export type DeletionBlocker = (typeof DELETION_BLOCKERS)[number]

export const DELETION_BLOCKER_MESSAGES: Record<DeletionBlocker, string> = {
  active_collabs:
    "You're in a collab that hasn't ended. Finish it, or ask your collaborator to end it with you, first.",
  open_disputes: "A dispute in one of your collabs is still open. Wait until our team resolves it.",
  unpaid_balance:
    "You have earnings that haven't been paid out yet (or an amount you owe). Wait for the next payout after the hold period.",
  pending_transfer: "A payout to you is on its way. Wait until it has gone through.",
}

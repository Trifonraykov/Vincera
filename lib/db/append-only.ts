import { sql } from "drizzle-orm"

import type { Tx } from "./client"

/**
 * Append-only tables (§4, §5, §11) are guarded by triggers (drizzle/0002_append_only_guards.sql):
 * UPDATE, DELETE and TRUNCATE raise SQLSTATE AO001 (`PG_ERROR.appendOnlyViolation`).
 * ledger_entries additionally allows setting `transfer_id` once, from NULL.
 */
export const APPEND_ONLY_TABLES = [
  "events",
  "audience_snapshots",
  "proposal_revisions",
  "agreement_signatures",
  "link_clicks",
  "admin_audit_log",
  "ledger_entries",
  "ledger_adjustments",
] as const

/** Append-only tables whose rows may be deleted for GDPR erasure (§14). */
export const GDPR_ERASABLE_TABLES = ["audience_snapshots"] as const

/**
 * Append-only columns that GDPR erasure may set to NULL (and nothing else), migration 0011
 * (`gdpr_redaction_guard`; CLAUDE.md §19.38): the deleting user's own proposal messages and the
 * IP address and browser of their agreement signatures.
 */
export const GDPR_REDACTABLE_COLUMNS = {
  proposal_revisions: ["message"],
  agreement_signatures: ["ip", "user_agent"],
} as const

/**
 * Allow GDPR erasure (§14) for the rest of transaction `tx`: rows of `GDPR_ERASABLE_TABLES` may be
 * deleted, e.g. when a social account is disconnected, and `GDPR_REDACTABLE_COLUMNS` may be set to
 * NULL. Every other change stays blocked. Only call this from the erasure code paths.
 */
export async function allowGdprErasure(tx: Tx): Promise<void> {
  await tx.execute(sql`select set_config('app.gdpr_erasure', 'on', true)`)
}

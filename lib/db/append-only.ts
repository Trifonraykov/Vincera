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
] as const

/** Append-only tables whose rows may be deleted for GDPR erasure (§14). */
export const GDPR_ERASABLE_TABLES = ["audience_snapshots"] as const

/**
 * Allow GDPR erasure (§14) for the rest of transaction `tx`: rows of `GDPR_ERASABLE_TABLES` may be
 * deleted, e.g. when a social account is disconnected. Updates stay blocked. Only call this from
 * the erasure code paths.
 */
export async function allowGdprErasure(tx: Tx): Promise<void> {
  await tx.execute(sql`select set_config('app.gdpr_erasure', 'on', true)`)
}
